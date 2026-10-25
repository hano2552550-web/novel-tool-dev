/*
 * 詳細チェック（辞書を使う校正）のワーカー
 * - 形態素解析：kuromoji.js（Apache License 2.0）と IPADIC（NOTICE を参照）
 * - 本文はこのワーカーの中（＝利用者のブラウザの中）だけで処理され、外部には送られません。
 *   ネットワークを使うのは、同じサイトに置いた辞書ファイルを読み込むときだけです。
 */
'use strict';
importScripts('kuromoji.js');

let tokenizer = null, loading = null;
function ready() {
  if (tokenizer) return Promise.resolve(tokenizer);
  if (!loading) loading = new Promise((resolve, reject) => {
    kuromoji.builder({dicPath: 'dict/'}).build((err, tk) => { if (err) { loading = null; reject(err); } else { tokenizer = tk; resolve(tk); } });
  });
  return loading;
}

const isKanaOnly = s => /^[ぁ-ゟ゠-ヿー]+$/.test(s);
const hasKanji = s => /[一-龠々]/.test(s);
const PARTICLES = new Set(['は', 'が', 'を', 'に', 'で', 'と', 'へ', 'から', 'より', 'まで']);

function analyze(text, terms) {
  const termSet = new Set(terms || []);
  const res = {successive: [], verbDup: [], adjDup: [], oddAux: [], doubledJoshi: [], yureReading: [], unknownKana: [], strayAlpha: []};
  const groups = {};
  let pos = 0;
  for (const line of text.split('\n')) {
    if (line.trim()) {
      const toks = tokenizer.tokenize(line);
      const at = t => pos + t.word_position - 1;
      // 名前など作品メモの用語が分解されて誤検出しないよう、用語の範囲を記録しておく
      const termRanges = [];
      for (const term of termSet) { let i = line.indexOf(term); while (i !== -1) { termRanges.push([pos + i, pos + i + term.length]); i = line.indexOf(term, i + 1); } }
      const inTerm = (s, e) => termRanges.some(([a, b]) => s < b && a < e);

      for (let i = 0; i < toks.length; i++) {
        const t = toks[i], n = toks[i + 1];
        const s = at(t), len = t.surface_form.length;
        if (inTerm(s, s + len)) continue;

        // 1) 助詞・助動詞が同じものの連続（がが、はは、のの など）
        if (n && n.surface_form === t.surface_form && (t.pos === '助詞' || t.pos === '助動詞') && !inTerm(at(n), at(n) + n.surface_form.length)) {
          res.successive.push({index: s, length: len * 2, msg: `「${t.surface_form}」が2回続いています（打ち間違いの可能性）`, fixText: t.surface_form});
        }
        // 2) 動詞の重なり（表情にででる → で＋でる）
        if (n && t.pos === '動詞' && n.pos === '動詞' && n.pos_detail_1 === '非自立' && t.basic_form === n.basic_form && t.basic_form !== '*') {
          res.verbDup.push({index: s, length: len + n.surface_form.length, msg: `同じ動詞「${t.basic_form}」が重なっています（例：「でる」→「ででる」のような打ち間違いの可能性）`, fixText: n.surface_form});
        }
        // 3) 形容詞が切れ目なく続く（かわいいい → かわい＋いい）
        if (n && t.pos === '形容詞' && n.pos === '形容詞' && !/連用/.test(t.conjugated_form) && /^い+$|^いい$/.test(n.surface_form)) {
          res.adjDup.push({index: s, length: len + n.surface_form.length, msg: `「${t.surface_form}${n.surface_form}」：文字が重なっている可能性があります`});
        }
        // 4) 現代文ではまず使わない文語の助動詞「り」（そのとおりりだ など、文字の重なり）
        if (t.pos === '助動詞' && t.basic_form === 'り' && i > 0) {
          const p = toks[i - 1];
          res.oddAux.push({index: at(p), length: p.surface_form.length + len, msg: `「${p.surface_form}${t.surface_form}」：文字が重なっている可能性があります`, fixText: p.surface_form});
        }
        // 5) 同じ助詞が近くで重なる（私は彼は など）。読点をはさむものは除く
        if (t.pos === '助詞' && PARTICLES.has(t.surface_form) && /格助詞|係助詞/.test(t.pos_detail_1)) {
          for (let k = i + 1; k <= i + 3 && k < toks.length; k++) {
            const u = toks[k];
            if (u.surface_form === '、' || u.pos === '記号') break;
            if (u.surface_form === t.surface_form && u.pos === '助詞' && k - i === 2) { // すぐ隣（がが など）は別の項目で指摘
              res.doubledJoshi.push({index: at(u), length: u.surface_form.length, msg: `すぐ前にも助詞「${t.surface_form}」があります（「私は彼は」のような重なり）。文の組み立てを確認してください`});
              break;
            }
          }
        }
        // 6) 読みが同じで、漢字とかなの書き方が違う言葉（出来る／できる、事／こと など）
        if (/名詞|動詞|形容詞|副詞/.test(t.pos) && !/固有名詞|数|代名詞|接尾/.test(t.pos_detail_1) && t.reading && t.reading !== '*' && t.reading.length >= 2) {
          const key = t.pos + '|' + t.reading + '|' + t.conjugated_form;
          (groups[key] = groups[key] || {}); (groups[key][t.surface_form] = groups[key][t.surface_form] || []).push(s);
        }
        // 7) 辞書にない、ひらがなだけの言葉（打ち間違いの可能性）
        // （口調の崩しや擬音で誤検出しやすいので、小書きの文字を含むもの・長いもの・前後も辞書にない並びは除く）
        const unk = x => x && x.word_type === 'UNKNOWN';
        if (t.word_type === 'UNKNOWN' && /^[ぁ-ゟ]{2,4}$/.test(t.surface_form) && !/[ぁぃぅぇぉゃゅょゎっー]/.test(t.surface_form) && !unk(toks[i - 1]) && !unk(n)) {
          res.unknownKana.push({index: s, length: len, msg: `「${t.surface_form}」は辞書にない言葉です（打ち間違い・造語でなければ確認してください）`});
        }
        // 8) 日本語の中にぽつんと混じった英字（行こうkと → 変換確定ミス）
        if (/^[A-Za-zＡ-Ｚａ-ｚ]{1,2}$/.test(t.surface_form)) {
          const p = toks[i - 1];
          const jp = x => x && /[ぁ-んァ-ン一-龠]/.test(x.surface_form);
          if (jp(p) && (jp(n) || !n)) res.strayAlpha.push({index: s, length: len, msg: `日本語の中に英字「${t.surface_form}」が混じっています（変換確定のミスの可能性）`, fixText: ''});
        }
      }
    }
    pos += line.length + 1;
  }
  // 表記ゆれ：同じ読み・品詞で、かなだけの書き方と漢字を含む書き方が両方ある
  for (const key in groups) {
    const forms = Object.entries(groups[key]);
    if (forms.length < 2) continue;
    const kana = forms.filter(([w]) => isKanaOnly(w)), kanji = forms.filter(([w]) => hasKanji(w));
    if (!kana.length || !kanji.length) continue;
    if (forms.some(([w]) => termSet.has(w))) continue;
    forms.sort((a, b) => b[1].length - a[1].length);
    const [maj, majPos] = forms[0];
    for (const [w, idx] of forms.slice(1)) for (const i of idx) res.yureReading.push({index: i, length: w.length, msg: `表記ゆれ：「${w}」${idx.length}回 /「${maj}」${majPos.length}回（読みが同じ言葉）`, fixText: maj});
  }
  return res;
}

onmessage = async e => {
  const {id, text, terms} = e.data;
  try {
    const t0 = Date.now();
    await ready();
    const results = analyze(text, terms);
    postMessage({id, ok: true, results, ms: Date.now() - t0});
  } catch (err) {
    postMessage({id, ok: false, error: String(err && err.message || err)});
  }
};
