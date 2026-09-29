import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYS = `Você é um orçamentista de construção civil no Brasil que monta cotações de materiais e serviços.
Para cada item pedido, PESQUISE NA INTERNET preços reais na cidade/região informada, em cerca de 5 fornecedores diferentes (lojas de material de construção, home centers, atacadistas, marketplaces com entrega para a cidade).
Regras:
- Padronize a unidade (ex.: prego em kg) e informe cada preço já convertido para essa unidade.
- Nunca invente preço ou fornecedor. Se achar menos de 5 fontes, devolva só as encontradas e avise na resposta.
- Se não achar nenhuma fonte, devolva o item com "fontes":[] e "preco_unit" como estimativa, e diga que é estimativa.
- Devolva SEMPRE a lista completa e atualizada de itens (não só os novos) e aplique remoções/ajustes pedidos.
- Faça no máximo 1 pergunta curta se faltar informação essencial (bitola, marca, quantidade).
Responda SOMENTE com JSON, sem markdown:
{"resposta":"texto curto em português","itens":[{"categoria":"","descricao":"","unidade":"","quantidade":0,"preco_unit":0,"fontes":[{"fornecedor":"","preco":0,"url":""}]}]}`;

const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { text = '', hist = [], itens = [], uf = '', city = '' } = req.body || {};
  const prompt = `Local da obra: ${city || 'cidade não informada'} - ${uf || 'estado não informado'}
Lista atual (JSON): ${JSON.stringify(itens)}
Conversa recente:
${hist.slice(-10).map(m => (m.role === 'user' ? 'Usuário: ' : 'Assistente: ') + m.content).join('\n')}
Nova mensagem do usuário: ${text}`;
  try {
    const r = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
      contents: prompt,
      config: { systemInstruction: SYS, tools: [{ googleSearch: {} }] },
    });
    const raw = r.text || '';
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const out = (j.itens || []).map(i => {
      const f = (i.fontes || []).filter(x => +x.preco > 0);
      return { ...i, fontes: f, preco_unit: f.length ? Math.round(median(f.map(x => +x.preco)) * 100) / 100 : +i.preco_unit || 0 };
    });
    res.json({ resposta: j.resposta, itens: out, sugestoes: r.candidates?.[0]?.groundingMetadata?.searchEntryPoint?.renderedContent || '' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha: ' + (e?.message || String(e)).slice(0, 400) });  }
}
