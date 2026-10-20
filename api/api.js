const BASE = 'https://api.orcafascio.com/api/public/v2';
const env = k => (process.env[k] || '').trim();

async function call(path, token, method, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`OrçaFascio ${method} ${path} → ${r.status}: ${t.slice(0, 500)}`);
  return t ? JSON.parse(t) : {};
}

async function login() {
  const a = await call('/authenticate', '', 'POST', { email: env('ORCAFASCIO_EMAIL'), secret_token: env('ORCAFASCIO_SECRET_TOKEN') });
  return a.data.attributes.access_token;
}

export default async function handler(req, res) {
  const real = env('ACCESS_CODE');
  const sent = String(req.headers['x-access-code'] || req.query.code || '').trim();
  if (!real || sent !== real) return res.status(401).json({ error: 'Código de acesso inválido.' });
  if (!env('ORCAFASCIO_EMAIL') || !env('ORCAFASCIO_SECRET_TOKEN')) return res.status(500).json({ error: 'Faltam ORCAFASCIO_EMAIL ou ORCAFASCIO_SECRET_TOKEN na Vercel.' });

  try {
    // Auxiliares de configuração (abrir no navegador): ?grupos=1  e  ?composicao=<id>
    if (req.method === 'GET') {
      const token = await login();
      if (req.query.grupos) {
        const g = await call('/my_database/groups?page%5Bsize%5D=100', token, 'GET');
        return res.json((g.data || []).map(x => ({ id: x.id, nome: x.attributes.description })));
      }
      if (/^[a-f0-9]{24}$/.test(String(req.query.composicao || ''))) {
        return res.json(await call('/my_database/compositions/' + req.query.composicao, token, 'GET'));
      }
      return res.status(400).json({ error: 'Use ?grupos=1 ou ?composicao=<id>' });
    }
    if (req.method !== 'POST') return res.status(405).end();

    const miss = ['ORCAFASCIO_GROUP_ID', 'ORCAFASCIO_BANK'].filter(k => !env(k));
    if (miss.length) return res.status(500).json({ error: 'Faltam variáveis na Vercel: ' + miss.join(', ') });

    const { nome = 'Cotação IA', uf = '', itens = [] } = req.body || {};
    if (!/^[A-Z]{2}$/.test(uf)) return res.status(400).json({ error: 'Selecione o estado antes de enviar.' });
    const validos = itens.filter(i => +i.preco_unit > 0 && +i.quantidade > 0);
    const ignorados = itens.filter(i => !validos.includes(i)).map(i => i.descricao);
    if (!validos.length) return res.status(400).json({ error: 'Nenhum item com preço para enviar.' });

    const token = await login();
    const stamp = Date.now().toString(36).toUpperCase();

    // 1) cria os insumos na Minha Base
    const criados = [];
    for (const [n, i] of validos.entries()) {
      const code = `IA-${stamp}-${n + 1}`;
      const fontes = Array.isArray(i.fontes) ? i.fontes : [];
      await call('/my_database/resources', token, 'POST', {
        group_id: env('ORCAFASCIO_GROUP_ID'),
        code,
        secondary_code: 'COTACAO-IA',
        description: String(i.descricao).slice(0, 250),
        unit: String(i.unidade || 'UN').toUpperCase(),
        type: env('ORCAFASCIO_RESOURCE_TYPE') || '4',
        status: true,
        note: `Mediana de ${fontes.length} preço(s). ` + fontes.map(f => f.url).filter(Boolean).join(' ').slice(0, 800),
        location: uf,
        price: +i.preco_unit,
      });
      criados.push({ code, quantity: +i.quantidade });
    }

    // 2) cria a composição própria
    const compCode = `COT-IA-${stamp}`;
    const comp = await call('/my_database/compositions', token, 'POST', {
      code: compCode,
      secondary_code: 'COTACAO-IA',
      description: String(nome).slice(0, 250),
      type: env('ORCAFASCIO_COMP_TYPE') || 'FOMA',
      unit: 'UN',
      location: uf,
      is_sicro: false,
      note: 'Criada pelo assistente de cotação',
    });

    // 3) adiciona os insumos criados dentro da composição
    await call(`/my_database/compositions/${comp.data.id}/add_items`, token, 'POST', {
      items: criados.map(c => ({ bank: env('ORCAFASCIO_BANK'), code: c.code, quantity: c.quantity, resource: true })),
    });

    res.json({ composicao: compCode, id: comp.data.id, insumos: criados.map(c => c.code).join(', '), ignorados: ignorados.join('; ') });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: (e?.message || String(e)).slice(0, 700) });
  }
}