import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ACCESS_CODE = 'teste';
process.env.GROQ_API_KEY = 'simulado';
process.env.TAVILY_API_KEY = 'simulado';
const { default: handler } = await import('../api/chat.js');
const url = 'https://www.obramax.com.br/cimento/p';
const item = { descricao: 'Cimento 50 kg', unidade: 'SC', quantidade: 2 };
const response = value => ({ ok: true, text: async () => JSON.stringify(value) });

async function run(t, { results, sources = [], failSearch = false, existing = [] }) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (endpoint, options) => {
    const body = JSON.parse(options.body);
    calls.push({ endpoint, body });
    if (endpoint.includes('tavily')) {
      if (failSearch) return { ok: false, status: 429, text: async () => 'Limite de consultas' };
      const index = calls.filter(c => c.endpoint.includes('tavily')).length - 1;
      return response({ results: results[Math.min(index, results.length - 1)] });
    }
    const plan = calls.filter(c => c.endpoint.includes('groq')).length === 1;
    return response({ choices: [{ message: { content: JSON.stringify(plan
      ? { resposta: 'Consulta realizada', buscar: [item], remover: [] }
      : { fontes: sources }) } }] });
  });
  let output;
  await handler({ method: 'POST', headers: { 'x-access-code': 'teste' }, body: {
    text: 'Cote novamente', itens: existing, city: 'Fortaleza', uf: 'Ceará',
  } }, { status() { return this; }, json(value) { output = value; } });
  return { output, calls };
}

test('preserva preço no conteúdo da página e envia local e preço anterior ao planejador', async t => {
  const { output, calls } = await run(t, {
    results: [[{ url, content: 'Descrição '.repeat(60), raw_content: 'Cimento 50 kg: R$ 35,00' }]],
    sources: [{ url, fornecedor: 'Obramax', preco: 35 }], existing: [{ ...item, preco_unit: 0 }],
  });
  assert.equal(output.itens[0].preco_unit, 35);
  const search = calls.find(c => c.endpoint.includes('tavily')).body;
  assert.equal(search.include_raw_content, true);
  assert.deepEqual(search.include_domains, ['obramax.com.br']);
  const llms = calls.filter(c => c.endpoint.includes('groq'));
  assert.match(llms[0].body.messages[1].content, /Fortaleza, Ceará/);
  assert.match(llms[0].body.messages[1].content, /"preco_unit":0/);
  assert.match(llms[1].body.messages[1].content, /R\$ 35,00/);
});

test('repete busca vazia com outra consulta', async t => {
  const { output, calls } = await run(t, {
    results: [[], [{ url, content: 'R$ 35,00 por saco de 50 kg' }]], sources: [{ url, preco: 35 }],
  });
  const searches = calls.filter(c => c.endpoint.includes('tavily'));
  assert.equal(searches.length, 2);
  assert.notEqual(searches[0].body.query, searches[1].body.query);
  assert.equal(output.itens[0].status_busca, 'cotado');
});

test('rejeita links inventados, externos e preços não finitos', async t => {
  const { output } = await run(t, {
    results: [[{ url, content: 'Cimento' }]], sources: [
      { url: 'https://outraloja.com/produto', preco: 20 },
      { url: 'https://www.obramax.com.br/inventado/p', preco: 20 },
      { url, preco: 'Infinity' },
    ],
  });
  assert.equal(output.itens[0].preco_unit, 0);
  assert.equal(output.itens[0].status_busca, 'sem_preco');
  assert.match(output.resposta, /sem preço explícito/);
});

test('diferencia busca sem resultados de página sem preço', async t => {
  const { output } = await run(t, { results: [[]] });
  assert.equal(output.itens[0].status_busca, 'nao_encontrado');
  assert.match(output.resposta, /nenhum resultado encontrado/);
});

test('falha do serviço preserva cotação anterior e informa erro', async t => {
  const existing = [{ ...item, preco_unit: 30 }];
  const { output } = await run(t, { failSearch: true, existing });
  assert.deepEqual(output.itens, existing);
  assert.match(output.resposta, /429/);
});
