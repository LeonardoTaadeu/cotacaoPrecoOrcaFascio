const GROQ = (process.env.GROQ_API_KEY || '').trim();
const TAVILY = (process.env.TAVILY_API_KEY || '').trim();
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// Para escalar: adicione outras lojas aqui, ex.: { nome: 'Outra Loja', dominio: 'outraloja.com.br' }
const LOJAS = [{ nome: 'Obramax', dominio: 'obramax.com.br' }];

const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const dominioOk = u => { try { const h = new URL(u).hostname; return LOJAS.some(l => h === l.dominio || h.endsWith('.' + l.dominio)); } catch { return false; } };

async function llm(system, user) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GROQ },
    body: JSON.stringify({ model: MODEL, temperature: 0.1, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error('Groq ' + r.status + ': ' + t.slice(0, 300));
  return JSON.parse(JSON.parse(t).choices[0].message.content);
}

async function search(q) {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TAVILY },
    body: JSON.stringify({ query: q, max_results: 8, search_depth: 'basic', include_domains: LOJAS.map(l => l.dominio) }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error('Tavily ' + r.status + ': ' + t.slice(0, 300));
  return (JSON.parse(t).results || []).map(x => ({ titulo: x.title, url: x.url, trecho: (x.content || '').slice(0, 450) }));
}

const PLAN = `Você é orçamentista de construção civil no Brasil. Leia a conversa e decida o que pesquisar.
Os preços serão buscados exclusivamente na loja ${LOJAS.map(l => l.nome).join(', ')}.
Responda SOMENTE JSON: {"resposta":"texto curto em português","buscar":[{"categoria":"","descricao":"","unidade":"","quantidade":0,"consulta":"nome do produto como se busca em uma loja"}],"remover":["descrição exata de itens da lista atual a remover"]}
Regras: no máximo 4 itens em "buscar" por vez; "buscar" só para itens novos ou que mudaram; se faltar informação essencial (bitola, quantidade), faça 1 pergunta curta em "resposta" e deixe "buscar" vazio; use unidades usuais (kg, m², sc, un, m³).`;

const EXTRACT = `Você extrai preços de trechos de páginas de loja (${LOJAS.map(l => l.nome).join(', ')}). Use APENAS os trechos fornecidos, sem inventar nada.
Responda SOMENTE JSON: {"fontes":[{"fornecedor":"Loja - nome curto do produto/marca","preco":0,"url":""}]}
Regras: até 5 produtos DIFERENTES (marcas, modelos ou embalagens distintas) com preço explícito no trecho; converta cada preço para preço por UNIDADE pedida (ex.: caixa de 1 kg = preço por kg); se não der para converter com segurança, ignore; ignore produtos de outro tipo; use o url exato do trecho; se não houver nenhum, devolva "fontes":[].`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const real = (process.env.ACCESS_CODE || '').trim();
  if (!real) return res.status(500).json({ error: 'ACCESS_CODE não chegou ao servidor.' });
  if (String(req.headers['x-access-code'] || '').trim() !== real) return res.status(401).json({ error: 'Código de acesso inválido.' });
  if (!GROQ) return res.status(500).json({ error: 'GROQ_API_KEY não chegou ao servidor. Confira o nome e faça Redeploy.' });
  if (!TAVILY) return res.status(500).json({ error: 'TAVILY_API_KEY não chegou ao servidor. Confira o nome e faça Redeploy.' });

  const { text = '', hist = [], itens = [] } = req.body || {};
  try {
    const plan = await llm(PLAN, `Lista atual: ${JSON.stringify(itens.map(i => ({ descricao: i.descricao, unidade: i.unidade, quantidade: i.quantidade })))}
Conversa: ${hist.slice(-8).map(m => m.role + ': ' + m.content).join(' | ')}
Nova mensagem: ${text}`);

    let lista = itens.filter(i => !(plan.remover || []).includes(i.descricao));
    const avisos = [];
    for (const b of (plan.buscar || []).slice(0, 4)) {
      const resultados = await search(`${b.consulta || b.descricao} preço`);
      const ex = resultados.length
        ? await llm(EXTRACT, `Item: ${b.descricao}\nUnidade pedida: ${b.unidade}\nTrechos: ${JSON.stringify(resultados)}`)
        : { fontes: [] };
      const vistos = new Set();
      const f = (ex.fontes || []).filter(x => +x.preco > 0 && dominioOk(x.url)).filter(x => {
        const k = x.url + '|' + x.preco; if (vistos.has(k)) return false; vistos.add(k); return true;
      }).slice(0, 5);
      const novo = { categoria: b.categoria || '', descricao: b.descricao, unidade: b.unidade, quantidade: +b.quantidade || 1,
        fontes: f, preco_unit: f.length ? Math.round(median(f.map(x => +x.preco)) * 100) / 100 : 0 };
      if (f.length < 5) avisos.push(`${b.descricao}: ${f.length} preço(s) encontrado(s)${f.length ? '' : ', sem preço'}`);
      lista = lista.filter(i => i.descricao !== b.descricao).concat(novo);
    }
    const nota = avisos.length ? '\n\nAtenção: ' + avisos.join('; ') + '. Revise os valores.' : '';
    res.json({ resposta: (plan.resposta || 'Pronto.') + nota, itens: lista, sugestoes: '' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha: ' + (e?.message || String(e)).slice(0, 600) });
  }
}
