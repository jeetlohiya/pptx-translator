// Serverless function: POST /api/translate
import fetch from "node-fetch";
import JSZip from "jszip";
import { XMLParser, XMLBuilder } from "fast-xml-parser";

const PAPAGO_URL = "https://openapi.naver.com/v1/papago/n2mt";

async function papago(text, source, target, id, secret) {
  if (!text || !text.trim()) return text || "";
  const res = await fetch(PAPAGO_URL, {
    method: "POST",
    headers: {
      "X-Naver-Client-Id": id,
      "X-Naver-Client-Secret": secret,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
    },
    body: new URLSearchParams({ source, target, text })
  });
  if (!res.ok) throw new Error(`Papago ${res.status} ${await res.text()}`);
  const j = await res.json();
  return j.message.result.translatedText;
}

function collectATNodes(obj) {
  // find all a:t (text) nodes anywhere in the slide XML
  const out = [];
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (cur && typeof cur === "object") {
      for (const k in cur) {
        if (k === "a:t" && typeof cur[k] === "string") out.push({ parent: cur, key: k });
        else if (cur[k] && typeof cur[k] === "object") stack.push(cur[k]);
      }
    }
  }
  return out;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
    const { file_url, source_lang, dest_lang, client_id, client_secret } = req.body || {};
    if (!file_url || !source_lang || !dest_lang || !client_id || !client_secret) {
      return res.status(400).json({ error: "Missing fields" });
    }

    // 1) Download PPTX
    const r = await fetch(file_url);
    if (!r.ok) return res.status(400).json({ error: `Fetch PPTX failed ${r.status}` });
    const buf = Buffer.from(await r.arrayBuffer());

    // 2) Unzip PPTX
    const zip = await JSZip.loadAsync(buf);
    const parser = new XMLParser({ ignoreAttributes: false });
    const builder = new XMLBuilder({ ignoreAttributes: false });

    // 3) Translate each slide's text nodes (ppt/slides/slide*.xml)
    const slideFiles = Object.keys(zip.files).filter(p => p.startsWith("ppt/slides/slide") && p.endsWith(".xml"));
    for (const path of slideFiles) {
      const xml = await zip.file(path).async("string");
      const obj = parser.parse(xml);
      const nodes = collectATNodes(obj);
      for (const n of nodes) {
        const original = n.parent[n.key];
        const translated = await papago(original, source_lang, dest_lang, client_id, client_secret);
        n.parent[n.key] = translated;
      }
      const newXml = builder.build(obj);
      zip.file(path, newXml);
    }

    // 4) Rezip and return PPTX bytes
    const out = await zip.generateAsync({ type: "nodebuffer" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.status(200).send(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
