const browserHeaders = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 SWARMResearch/1.1',
  'Accept': 'text/plain,text/markdown,application/json,text/html,application/rss+xml',
  'Accept-Language': 'en-US,en;q=0.9'
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(payload));
}

async function fetchText(url, timeout = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: browserHeaders });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeout = 20000) {
  return JSON.parse(await fetchText(url, timeout));
}

function decodeHtml(text = '') {
  return String(text)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripHtml(html = '') {
  return decodeHtml(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(text = '') {
  return stripHtml(text)
    .replace(/\b(?:cached|similar|translate this page)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function topicWords(topic) {
  return String(topic).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
}

function decodeSearchUrl(url = '') {
  const decoded = decodeHtml(url);
  try {
    const u = new URL(decoded, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : decoded;
  } catch {
    return decoded;
  }
}

function compactItem(item) {
  const title = cleanText(item.title || '');
  const snippet = cleanText(item.snippet || item.text || '').slice(0, 700);
  if (!title && !snippet) return null;
  if (/^no results found\b|suggestions\s*:\s*check spelling/i.test(`${title} ${snippet}`)) return null;
  return {
    source: item.source,
    type: item.type || 'search_result',
    title,
    snippet,
    url: item.url || '',
    meta: item.meta || {}
  };
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const item = compactItem(raw);
    if (!item) continue;
    const key = (item.url || `${item.title} ${item.snippet}`).toLowerCase().replace(/\W+/g, ' ').slice(0, 180);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function topicMatchScore(text, topic) {
  const words = topicWords(topic);
  const lower = String(text).toLowerCase();
  if (!words.length) return 0;
  let score = lower.includes(String(topic).toLowerCase()) ? 12 : 0;
  const positions = words.map(word => lower.indexOf(word)).filter(pos => pos >= 0);
  score += positions.length * 3;
  if (positions.length >= Math.min(words.length, 2)) {
    const span = Math.max(...positions) - Math.min(...positions);
    if (span < 140) score += 8;
  }
  return score;
}

function scoreItem(item, topic) {
  const text = `${item.title} ${item.snippet}`.toLowerCase();
  let score = 0;
  score += topicMatchScore(text.slice(0, 900), topic);
  if (/(review|worth|bought|buy|buyer|using|used|customer|verified|stars?|problem|issue|complaint|love|recommend)/i.test(text)) score += 4;
  if (/(reddit|comment|thread|subreddit|x\.com|twitter|tweet|amazon|verified purchase)/i.test(`${item.url} ${text}`)) score += 3;
  if (item.type?.includes('comment')) score += 2;
  if (item.type?.includes('review')) score += 2;
  return score;
}

function rankItems(items, topic, limit = 24) {
  return dedupeItems(items)
    .map(item => ({ ...item, score: scoreItem(item, topic) }))
    .filter(item => item.score >= 10)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function parseDuckDuckGo(html, source) {
  const blocks = html.match(/<div class="result[\s\S]*?(?=<div class="result|<\/body>)/gi) || [];
  return blocks.slice(0, 12).map(block => {
    const titleMatch = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>|class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
    return {
      source,
      type: 'search_result',
      title: titleMatch ? titleMatch[2] : '',
      snippet: snippetMatch ? (snippetMatch[1] || snippetMatch[2]) : block,
      url: titleMatch ? decodeSearchUrl(titleMatch[1]) : ''
    };
  });
}

function parseBing(html, source) {
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/gi) || [];
  return blocks.slice(0, 12).map(block => {
    const link = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const snip = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    return {
      source,
      type: 'search_result',
      title: link ? link[2] : '',
      snippet: snip ? snip[1] : block,
      url: link ? decodeSearchUrl(link[1]) : ''
    };
  });
}

function parseJinaMarkdown(markdown, source, type = 'page_extract') {
  const lines = String(markdown).split(/\n+/).map(cleanText).filter(line => line.length > 35 && line.length < 320);
  return lines.slice(0, 30).map(line => ({ source, type, title: '', snippet: line, url: '' }));
}

async function searchPublic(query, source) {
  const endpoints = [
    { url: 'https://duckduckgo.com/html/?q=' + encodeURIComponent(query), parser: html => parseDuckDuckGo(html, source) },
    { url: 'https://www.bing.com/search?q=' + encodeURIComponent(query), parser: html => parseBing(html, source) }
  ];
  const items = [];
  const errors = [];
  for (const endpoint of endpoints) {
    try {
      items.push(...endpoint.parser(await fetchText(endpoint.url, 18000)));
    } catch (e) {
      errors.push(String(e.message || e));
    }
  }
  return { items, errors };
}

async function redditComments(permalink) {
  if (!permalink) return [];
  const url = 'https://www.reddit.com' + permalink.replace(/\/?$/, '.json?limit=12&raw_json=1');
  try {
    const data = await fetchJson(url, 14000);
    const post = data?.[0]?.data?.children?.[0]?.data || {};
    const comments = data?.[1]?.data?.children || [];
    return comments.map(child => {
      const c = child.data || {};
      return {
        source: 'reddit',
        type: 'reddit_comment',
        title: post.title || 'Reddit comment',
        snippet: c.body || '',
        url: permalink ? 'https://www.reddit.com' + permalink : '',
        meta: { ups: c.ups, subreddit: c.subreddit }
      };
    });
  } catch {
    return [];
  }
}

function parseRedditRss(rss) {
  const entries = String(rss).match(/<entry>[\s\S]*?<\/entry>/g) || [];
  return entries.slice(0, 14).map(entry => {
    const title = decodeHtml((entry.match(/<title>([\s\S]*?)<\/title>/) || [,''])[1]);
    const author = stripHtml((entry.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/) || [,''])[1]);
    const subreddit = stripHtml((entry.match(/<category[^>]*label="([^"]+)"/) || [,''])[1]);
    const link = decodeHtml((entry.match(/<link[^>]*href="([^"]+)"/) || [,''])[1]);
    const content = stripHtml((entry.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [,''])[1]);
    return {
      source: 'reddit',
      type: 'reddit_rss_post',
      title,
      snippet: [content, subreddit ? `Subreddit: ${subreddit}` : '', author ? `Author: ${author}` : ''].filter(Boolean).join(' '),
      url: link,
      meta: { subreddit, author }
    };
  });
}

async function redditResearch(topic) {
  const queries = [
    `"${topic}" review problem worth it`,
    `"${topic}" complaints issues honest review`,
    `"${topic}" love recommend buyer experience`
  ];
  const items = [];
  const errors = [];

  for (const q of queries) {
    try {
      const rss = await fetchText('https://www.reddit.com/search.rss?q=' + encodeURIComponent(q) + '&sort=relevance&t=year', 16000);
      items.push(...parseRedditRss(rss));
    } catch (e) {
      errors.push(String(e.message || e));
    }
    try {
      const data = await fetchJson('https://www.reddit.com/search.json?q=' + encodeURIComponent(q) + '&sort=relevance&t=year&limit=12&raw_json=1', 16000);
      const posts = data?.data?.children || [];
      for (const child of posts) {
        const p = child.data || {};
        items.push({
          source: 'reddit',
          type: 'reddit_post',
          title: p.title || '',
          snippet: p.selftext || '',
          url: p.permalink ? 'https://www.reddit.com' + p.permalink : '',
          meta: { subreddit: p.subreddit, comments: p.num_comments, ups: p.ups }
        });
      }
      for (const child of posts.slice(0, 3)) {
        items.push(...await redditComments(child.data?.permalink));
      }
    } catch (e) {
      errors.push(String(e.message || e));
    }
  }

  const web = await searchPublic(`site:reddit.com "${topic}" reddit review complaints praise buyer experience`, 'reddit');
  items.push(...web.items);
  errors.push(...web.errors);

  const ranked = rankItems(items, topic, 28);
  return {
    source: 'reddit',
    topic,
    queries,
    count: ranked.length,
    items: ranked,
    errors,
    text: ranked.map(item => `${item.title}\n${item.snippet}\n${item.url}`).join('\n\n')
  };
}

async function xResearch(topic) {
  const token = process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN || '';
  if (token) {
    try {
      const query = `"${topic}" (review OR problem OR complaint OR worth OR love OR recommend) -is:retweet lang:en`;
      const url = 'https://api.twitter.com/2/tweets/search/recent?max_results=25&tweet.fields=created_at,public_metrics&query=' + encodeURIComponent(query);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 18000);
      const res = await fetch(url, { signal: ctrl.signal, headers: { Authorization: `Bearer ${token}` } });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        const ranked = rankItems((data.data || []).map(tweet => ({
          source: 'x',
          type: 'x_api_tweet',
          title: `X post ${tweet.created_at || ''}`,
          snippet: tweet.text || '',
          url: `https://x.com/i/web/status/${tweet.id}`,
          meta: tweet.public_metrics || {}
        })), topic, 24);
        return {
          source: 'x',
          topic,
          queries: [query],
          count: ranked.length,
          items: ranked,
          errors: [],
          text: ranked.map(item => `${item.title}\n${item.snippet}\n${item.url}`).join('\n\n')
        };
      }
    } catch {}
  }

  const queries = [
    `site:x.com "${topic}" review OR worth OR problem OR love`,
    `site:twitter.com "${topic}" review OR complaint OR recommend`,
    `"${topic}" "x.com" viral review hot take`
  ];
  const items = [];
  const errors = [];
  for (const q of queries) {
    const result = await searchPublic(q, 'x');
    items.push(...result.items);
    errors.push(...result.errors);
  }
  const ranked = rankItems(items, topic, 24);
  return {
    source: 'x',
    topic,
    queries,
    count: ranked.length,
    items: ranked,
    errors,
    text: ranked.map(item => `${item.title}\n${item.snippet}\n${item.url}`).join('\n\n')
  };
}

function amazonUrlsFromText(text) {
  const urls = new Set();
  const asinMatches = String(text).match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/g) || [];
  for (const match of asinMatches) {
    const asin = match.match(/[A-Z0-9]{10}/)?.[0];
    if (asin) urls.add(`https://www.amazon.com/product-reviews/${asin}/?sortBy=recent`);
  }
  return [...urls].slice(0, 3);
}

async function amazonResearch(topic) {
  const queries = [
    `site:amazon.com "${topic}" "customer reviews" "verified purchase"`,
    `site:amazon.com "${topic}" "1 star" OR "5 star" review`,
    `"${topic}" amazon review complaints worth it`
  ];
  const items = [];
  const errors = [];

  for (const q of queries) {
    const result = await searchPublic(q, 'amazon');
    items.push(...result.items);
    errors.push(...result.errors);
  }

  let listing = '';
  try {
    listing = await fetchText('https://r.jina.ai/https://www.amazon.com/s?k=' + encodeURIComponent(topic), 20000);
    items.push(...parseJinaMarkdown(listing, 'amazon', 'amazon_listing'));
  } catch (e) {
    errors.push(String(e.message || e));
  }

  const reviewUrls = amazonUrlsFromText([listing, ...items.map(item => item.url)].join('\n'));
  for (const reviewUrl of reviewUrls) {
    try {
      const text = await fetchText('https://r.jina.ai/' + reviewUrl, 18000);
      items.push(...parseJinaMarkdown(text, 'amazon', 'amazon_review').map(item => ({ ...item, url: reviewUrl })));
    } catch (e) {
      errors.push(String(e.message || e));
    }
  }

  const ranked = rankItems(items, topic, 28);
  return {
    source: 'amazon',
    topic,
    queries,
    count: ranked.length,
    items: ranked,
    errors,
    text: ranked.map(item => `${item.title}\n${item.snippet}\n${item.url}`).join('\n\n')
  };
}

const problemPatterns = [
  { key:'irritation', rx:/razor|wax|waxing|shav|thread|threading|burn|bumps|redness|irritation|ingrown|regrowth|stubble|painful|hair removal|depilatory/i, label:'razor bumps, painful removal, fast regrowth, or skin irritation' },
  { key:'leaks', rx:/leak|spill|lid|seal|drip/i, label:'leaks, spills, or unreliable sealing' },
  { key:'durability', rx:/broke|crack|dent|scratch|cheap|flimsy|stopped working|quality|durable/i, label:'durability or quality concerns' },
  { key:'cleaning', rx:/clean|mold|smell|odor|stain|dishwasher|straw/i, label:'cleaning, odor, or maintenance friction' },
  { key:'fit', rx:/fit|size|too big|too small|heavy|bulky|cup holder|carry/i, label:'fit, size, weight, or portability issues' },
  { key:'value', rx:/expensive|overpriced|price|worth|refund|returned|waste|regret/i, label:'price-to-value doubts' },
  { key:'performance', rx:/cold|hot|battery|charge|slow|doesn't work|performance|last/i, label:'performance that does not match the promise' },
  { key:'trust', rx:/\b(fake|counterfeit|seller|shipping|missing item|arrived used|used like new|warehouse|customer support|warranty)\b/i, label:'trust, shipping, or support problems' }
];

function short(text, fallback = '', max = 140) {
  const cleaned = cleanText(text || fallback);
  if (!cleaned) return fallback;
  return cleaned.length > max ? cleaned.slice(0, max - 3).replace(/\s+\S*$/, '') + '...' : cleaned;
}

function allEvidence(results) {
  return ['reddit', 'x', 'amazon'].flatMap(source =>
    (results[source]?.items || []).map(item => ({
      source,
      title: item.title || '',
      snippet: item.snippet || '',
      url: item.url || '',
      text: cleanText([item.title, item.snippet].filter(Boolean).join(' - ')),
      score: item.score || 0
    }))
  ).filter(item => item.text.length > 35);
}

function classifyProblem(item) {
  return problemPatterns.find(pattern => pattern.rx.test(item.text)) || null;
}

function extractProblems(topic, results) {
  const grouped = new Map();
  for (const item of allEvidence(results)) {
    const pattern = classifyProblem(item);
    if (!pattern) continue;
    if (!grouped.has(pattern.key)) {
      grouped.set(pattern.key, { key: pattern.key, problem: pattern.label, sources: new Set(), evidence: [], score: 0 });
    }
    const group = grouped.get(pattern.key);
    group.sources.add(item.source);
    group.evidence.push(item);
    group.score += item.score + 1;
  }

  const problems = [...grouped.values()].map(group => ({
    key: group.key,
    problem: group.problem,
    sources: [...group.sources],
    evidence: group.evidence.sort((a, b) => b.score - a.score).slice(0, 5),
    score: group.score
  })).sort((a, b) => (b.sources.length - a.sources.length) || (b.score - a.score)).slice(0, 5);

  if (problems.length) return problems;
  return [{
    key: 'generic',
    problem: `buyers are unsure whether ${topic} is worth it after real-world use`,
    sources: Object.keys(results).filter(key => results[key]?.count),
    evidence: allEvidence(results).slice(0, 5),
    score: 1
  }];
}

function resolutionFor(problem, productName, solution) {
  const product = productName || 'your product';
  const base = solution
    ? `${product} solves this by ${solution}`
    : `${product} should be positioned around the proof that it removes this exact friction`;
  const additions = {
    leaks: 'with a tighter seal, clearer leak-proof proof, and a demo people can see on camera',
    durability: 'with stronger materials, better quality checks, and visible stress-test proof',
    cleaning: 'with easier cleaning, fewer hard-to-reach parts, and maintenance that feels realistic',
    fit: 'with better everyday fit, lighter carry, and a clearer size/use-case promise',
    value: 'with a sharper value story: what buyers save, avoid, or get that cheaper options miss',
    performance: 'with performance proof under normal use, not just polished marketing claims',
    trust: 'with clearer fulfillment, authenticity, support, and warranty reassurance'
  };
  return solution ? base : `${base} ${additions[problem.key] || ''}`.trim();
}

function countWords(str) {
  return String(str || '').trim().split(/\s+/).filter(Boolean).length;
}

function platformBrief(platform) {
  const p = String(platform || '').toLowerCase();
  if (p.includes('instagram')) {
    return {
      platform: 'Instagram Reels',
      duration: '20-30 sec',
      estimated: 27,
      style: 'Aesthetic POV',
      audio: 'Soft trending audio',
      hookTime: '0-3 sec',
      problemTime: '3-8 sec',
      solutionTime: '8-20 sec',
      proofTime: '20-24 sec',
      ctaTime: '24-30 sec',
      cta: 'Link in bio to grab yours. Your skin deserves better than the same old routine.'
    };
  }
  if (p.includes('youtube')) {
    return {
      platform: 'YouTube Shorts',
      duration: '30-40 sec',
      estimated: 36,
      style: 'Fast comparison + proof',
      audio: 'Clean upbeat audio with bold text overlays',
      hookTime: '0-3 sec',
      problemTime: '3-10 sec',
      solutionTime: '10-25 sec',
      proofTime: '25-32 sec',
      ctaTime: '32-40 sec',
      cta: 'Check the link and compare it before you buy another one.'
    };
  }
  return {
    platform: 'TikTok',
    duration: '30-45 sec',
    estimated: 39,
    style: 'Casual & conversational',
    audio: 'Trending sound low under voiceover',
    hookTime: '0-3 sec',
    problemTime: '3-12 sec',
    solutionTime: '12-28 sec',
    proofTime: '28-35 sec',
    ctaTime: '35-45 sec',
    cta: 'Link is in my bio. Comment "LINK" and I will send it to you directly.'
  };
}

function problemCopy(problem, topic) {
  const map = {
    irritation: `razor bumps, painful waxing, fast regrowth, redness, and irritated skin`,
    leaks: `leaks, mess, and that annoying "will this spill in my bag?" anxiety`,
    durability: `products that look good online but feel cheap or wear out too fast`,
    cleaning: `hard-to-clean parts, weird smells, stains, and maintenance nobody wants`,
    fit: `stuff that is too bulky, awkward to carry, or just does not fit real life`,
    value: `spending money and still wondering if it was actually worth it`,
    performance: `big promises that do not hold up once you use it every day`,
    trust: `fake listings, missing parts, bad shipping, and support that disappears`
  };
  return map[problem.key] || `the frustrating part people keep mentioning about ${topic}`;
}

function benefitLine(problem, product, solution) {
  if (solution) return `${product} fixes that with ${solution}`;
  const map = {
    irritation: `${product} is positioned as a smoother, painless alternative that removes hair without the razor-burn routine`,
    leaks: `${product} is built around a cleaner, more reliable no-spill experience`,
    durability: `${product} focuses on stronger materials and proof you can actually see`,
    cleaning: `${product} keeps the routine simple with easier cleaning and less residue`,
    fit: `${product} is made to feel easier to carry, use, and fit into a normal day`,
    value: `${product} makes the value obvious by solving the pain people are already paying to avoid`,
    performance: `${product} shows the result in real use, not just in product-page claims`,
    trust: `${product} reduces the risk with clearer quality, support, and replacement proof`
  };
  return map[problem.key] || `${product} solves the exact friction buyers are already complaining about`;
}

function buildHashtags(topic, product, platform) {
  const base = String(topic).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2).slice(0, 3);
  const productTags = String(product).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2).slice(0, 2);
  const generic = platform.toLowerCase().includes('tiktok')
    ? ['tiktokmademebuyit','productreview','amazonfinds','lifehack','fyp','foryou']
    : ['reels','productreview','amazonfinds','lifehack','selfcare','musthave'];
  return [...new Set([...base, ...productTags, ...generic])].map(tag => `#${tag}`).join(' ');
}

function makeCaption(topic, product, problem, index) {
  const captions = [
    `The ${topic} fix I wish I found sooner.`,
    `I checked the reviews so you do not have to.`,
    `This solves the part everyone complains about.`,
    `Bad reviews basically wrote this product angle.`,
    `If ${topic} has ever annoyed you, watch this.`
  ];
  return `${captions[index % captions.length]}\n${product} is positioned around ${problemCopy(problem, topic)}.`;
}

function visualCue(problem, product) {
  const map = {
    irritation: `Start mid-application on skin. Show texture, wipe-off, then a smooth-skin reveal. No talking-head intro.`,
    leaks: `Start mid-action: product tilted over a bag or towel, then cut to a clean no-spill close-up.`,
    durability: `Show a hand pressing, dropping, or daily-use close-up. Keep it tactile, not polished.`,
    cleaning: `Show the messy part first, then a quick rinse/wipe/clean reveal.`,
    fit: `Show the old awkward version in a bag, car, hand, or counter, then the easier fit.`,
    value: `Show salon/competitor/old-cost text overlay, then the simpler product alternative.`,
    performance: `Show a real-time or sped-up before/after result, with the product visible.`,
    trust: `Show packaging, guarantee, replacement policy, or authenticity proof on screen.`
  };
  return map[problem.key] || `Start mid-use with ${product} already on screen. Avoid a talking-head intro.`;
}

function timeRange(start, end) {
  const s = String(start || '').split('-')[0].trim();
  const e = String(end || '').split('-').pop().trim();
  return `${s}-${e}`;
}

function afterProductPhrase(fix, product) {
  const stripped = String(fix).replace(new RegExp('^' + product.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+', 'i'), '');
  return stripped.replace(/^solves this by\s+/i, '');
}

function hookForStyle(style, { topic, product, problem, pain, sourceLine, index }) {
  const selected = String(style || 'Pain Point').toLowerCase();
  const hooks = {
    pain: [
      `I stopped dealing with ${pain} — and here is what actually worked.`,
      `${topic} has one problem real users keep bringing up.`,
      `If ${pain} is your problem, watch this before buying another ${topic}.`,
      `This is your sign to stop accepting ${pain}.`,
      `The annoying part of ${topic}? ${pain}.`
    ],
    hot: [
      `Hot take: most ${topic} content skips the part buyers actually complain about.`,
      `Unpopular opinion: ${topic} is not the problem — ${pain} is.`,
      `The real reason people regret ${topic} is not what the ads show.`,
      `Hot take: bad reviews are a better script than product features.`,
      `Everyone talks about ${topic}, but nobody talks about ${pain}.`
    ],
    story: [
      `I went through reviews for ${topic}, and the same complaint kept showing up.`,
      `I almost ignored ${product} until I saw what people were complaining about.`,
      `I found ${product} after getting tired of ${pain}.`,
      `I checked Reddit and Amazon before trying this, and the pattern was obvious.`,
      `This started with one review about ${pain}, then I kept seeing it everywhere.`
    ],
    surprising: [
      `The weirdest thing about ${topic} reviews is how often they mention ${pain}.`,
      `I did not expect ${topic} reviews to keep pointing to this one problem.`,
      `Surprising fact: the best product angle is hiding in the complaints.`,
      `One review pattern completely changed how I would sell ${product}.`,
      `The part nobody tells you about ${topic}: ${pain}.`
    ],
    question: [
      `Would you still buy ${topic} if reviews kept mentioning ${pain}?`,
      `Why are so many ${topic} buyers complaining about the same thing?`,
      `What if the best ${topic} ad starts with the worst review?`,
      `Is ${topic} actually worth it if this problem keeps showing up?`,
      `Have you dealt with ${pain}? This is the fix I would show first.`
    ],
    pov: [
      `POV: you found a ${topic} option that finally solves the part everyone complains about.`,
      `POV: you read the ${topic} reviews before buying.`,
      `POV: ${product} fixes the exact thing that made people hesitate.`,
      `POV: the comments saved you from ignoring ${pain}.`,
      `POV: you are done pretending ${pain} is normal.`
    ]
  };
  let bucket = hooks.pain;
  if (selected.includes('hot')) bucket = hooks.hot;
  else if (selected.includes('story')) bucket = hooks.story;
  else if (selected.includes('surprising')) bucket = hooks.surprising;
  else if (selected.includes('question')) bucket = hooks.question;
  else if (selected.includes('pov')) bucket = hooks.pov;
  return bucket[index % bucket.length].replace(/\s+/g, ' ').trim();
}

function visualForHookStyle(style, problem, product) {
  const selected = String(style || '').toLowerCase();
  if (selected.includes('hot')) return `Start with a bold text overlay: "hot take" then cut straight into ${visualCue(problem, product)}`;
  if (selected.includes('story')) return `Start like a mini story: product already in frame, then show the review/pain point that triggered the switch.`;
  if (selected.includes('surprising')) return `Start with a surprising text overlay, then reveal the product result before explaining it.`;
  if (selected.includes('question')) return `Put the question as big on-screen text, then answer it with the product demo.`;
  if (selected.includes('pov')) return `Use POV framing: hands-only, mid-action, viewer feels like they discovered it themselves.`;
  return visualCue(problem, product);
}

function scriptBody({ brief, topic, product, problem, evidence, fix, index, angle, hookStyle }) {
  const pain = problemCopy(problem, topic);
  const sourceLine = evidence?.text ? short(evidence.text, '', 115).replace(/\.+$/, '') : `real buyers keep bringing up ${pain}`;
  const angleText = angle ? ` for ${angle}` : '';
  const styledHook = hookForStyle(hookStyle, { topic, product, problem, pain, sourceLine, index });
  const styledVisual = visualForHookStyle(hookStyle, problem, product);
  const variants = [
    {
      label: 'Aesthetic POV',
      hook: styledHook,
      lines: [
        `Format: ${brief.platform}`,
        `Duration: ${brief.duration}`,
        `Style: ${brief.style}`,
        `Audio: ${brief.audio}`,
        ``,
        `Hook (${brief.hookTime})`,
        `"${styledHook}"`,
        `Visual: ${styledVisual}`,
        ``,
        `Problem (${brief.problemTime})`,
        `"Reviews kept mentioning ${pain}. Sound familiar?"`,
        `Text overlay: "${problem.problem}"`,
        ``,
        `Solution reveal (${brief.solutionTime})`,
        `"${fix}. I use it, show the exact result, and the annoying part is gone. No over-explaining, just the before, the process, and the clean reveal."`,
        ``,
        `Proof (${brief.proofTime})`,
        `"One review signal said: ${sourceLine}."`,
        ``,
        `CTA (${brief.ctaTime})`,
        `"${brief.cta}"`
      ]
    },
    {
      label: 'Casual Demo',
      hook: styledHook,
      lines: [
        `Format: ${brief.platform}`,
        `Duration: ${brief.duration}`,
        `Style: Casual demo + text overlays`,
        `Audio: ${brief.audio}`,
        ``,
        `Hook (${brief.hookTime})`,
        `"${styledHook}"`,
        `Visual: ${styledVisual}`,
        ``,
        `Story + demo (${timeRange(brief.problemTime, brief.solutionTime)})`,
        `"Ok, so I was looking through Reddit and Amazon reviews${angleText}, and the same complaint kept showing up: ${pain}. ${product} makes way more sense because it is built for ${afterProductPhrase(fix, product)}. You can literally show the problem, then show the fix in one shot."`,
        ``,
        `Social proof (${brief.proofTime})`,
        `"The review pattern was not random — people kept reacting to ${problem.problem}."`,
        ``,
        `CTA (${brief.ctaTime})`,
        `"${brief.cta}"`
      ]
    },
    {
      label: 'Review Receipts',
      hook: styledHook,
      lines: [
        `Format: ${brief.platform}`,
        `Duration: ${brief.duration}`,
        `Style: Review receipts + product demo`,
        `Audio: Soft beat under voiceover`,
        ``,
        `Hook (${brief.hookTime})`,
        `"${styledHook}"`,
        `Visual: Flash 2-3 blurred review-style screenshots or text overlays. Then show ${product} solving it.`,
        ``,
        `Problem (${brief.problemTime})`,
        `"People were tired of ${pain}. One signal I found was: ${sourceLine}."`,
        ``,
        `Solution reveal (${brief.solutionTime})`,
        `"So instead of selling another generic ${topic}, lead with the fix: ${fix}. Show it happening in real time so the viewer does not have to imagine the benefit."`,
        ``,
        `CTA (${brief.ctaTime})`,
        `"If this is the problem you are tired of too, ${brief.cta.charAt(0).toLowerCase() + brief.cta.slice(1)}"`
      ]
    },
    {
      label: 'Before/After',
      hook: styledHook,
      lines: [
        `Format: ${brief.platform}`,
        `Duration: ${brief.duration}`,
        `Style: Before/after transformation`,
        `Audio: Rising trending audio + quick cuts`,
        ``,
        `Hook (${brief.hookTime})`,
        `"${styledHook}"`,
        `Visual: Split screen: old problem on left, ${product} result on right.`,
        ``,
        `Problem (${brief.problemTime})`,
        `"The reviews were basically saying the same thing: people want the result without the annoying downside."`,
        ``,
        `Solution demo (${brief.solutionTime})`,
        `"Here is the switch: ${fix}. Show the product in use, then immediately show the result. Keep the camera close enough that the viewer can see proof, not just packaging."`,
        ``,
        `CTA (${brief.ctaTime})`,
        `"${brief.cta}"`
      ]
    },
    {
      label: 'UGC Testimonial',
      hook: styledHook,
      lines: [
        `Format: ${brief.platform}`,
        `Duration: ${brief.duration}`,
        `Style: UGC testimonial`,
        `Audio: Low-volume conversational trend`,
        ``,
        `Hook (${brief.hookTime})`,
        `"${styledHook}"`,
        `Visual: ${styledVisual}`,
        ``,
        `Story (${brief.problemTime})`,
        `"I kept seeing complaints about ${pain}, and honestly that was the exact thing that made me avoid buying."`,
        ``,
        `Solution (${brief.solutionTime})`,
        `"Then I tried ${product}. ${fix}. The best part is the result feels obvious on camera, so you can show it without sounding salesy."`,
        ``,
        `Urgency + CTA (${brief.proofTime}-${brief.ctaTime.split('-')[1]})`,
        `"If you have been dealing with the same thing, try it once. ${brief.cta}"`
      ]
    }
  ];
  return variants[index % variants.length];
}

function makeScripts({ topic, productName, solution, platform, hook, angle, results, problems }) {
  const product = productName || topic;
  const brief = platformBrief(platform);

  return Array.from({ length: 5 }, (_, index) => {
    const problem = problems[index % problems.length];
    const evidence = problem.evidence[index % Math.max(problem.evidence.length, 1)] || { text: `buyers mention ${problem.problem}` };
    const fix = resolutionFor(problem, product, solution);
    const script = scriptBody({ brief, topic, product, problem, evidence, fix, index, angle, hookStyle: hook });
    const body = script.lines.join('\n');
    const words = countWords(body);
    const caption = makeCaption(topic, product, problem, index);
    const hashtags = buildHashtags(topic, product, brief.platform);
    return {
      id: index + 1,
      label: `${script.label} · ${hook || 'Pain Point'}`,
      hook: script.hook,
      body,
      cta: brief.cta,
      caption,
      hashtags,
      word_count: words,
      estimated_seconds: brief.estimated,
      format: brief.platform,
      duration: brief.duration,
      style: brief.style,
      evidence: [
        `Problem: ${problem.problem}`,
        `Source: ${evidence.source || 'research'} - ${short(evidence.text, '', 150)}`,
        `Resolution: ${fix}`
      ],
      why_viral: `${hook || 'Pain Point'} hook: structured like a usable ${brief.platform} creator script with timed beats, visuals, caption, and hashtags.`
    };
  });
}

async function handleGenerate(req, res, url) {
  const topic = (url.searchParams.get('topic') || '').trim();
  const productName = (url.searchParams.get('product') || '').trim();
  const solution = (url.searchParams.get('solution') || '').trim();
  const platform = (url.searchParams.get('platform') || 'TikTok').trim();
  const hook = (url.searchParams.get('hook') || '').trim();
  const angle = (url.searchParams.get('angle') || '').trim();

  if (!topic) {
    sendJson(res, 400, { error: 'Missing topic/product to research.' });
    return;
  }

  try {
    const [reddit, x, amazon] = await Promise.all([
      redditResearch(topic),
      xResearch(topic),
      amazonResearch(topic)
    ]);
    const results = { reddit, x, amazon };
    const problems = extractProblems(topic, results);
    const scripts = makeScripts({ topic, productName, solution, platform, hook, angle, results, problems });
    sendJson(res, 200, {
      topic,
      productName,
      solution,
      platform,
      hook,
      angle,
      counts: { reddit: reddit.count, x: x.count, amazon: amazon.count },
      problems,
      scripts,
      research: results,
      warning: x.count ? '' : 'Public X/Twitter search returned limited indexed posts. Add X_BEARER_TOKEN/TWITTER_BEARER_TOKEN for direct recent tweet search.',
      fetchedAt: new Date().toISOString()
    });
  } catch (e) {
    sendJson(res, 502, { error: String(e.message || e), scripts: [], research: {}, problems: [] });
  }
}

async function handleResearch(req, res, url) {
  const topic = (url.searchParams.get('topic') || '').trim();
  const source = (url.searchParams.get('source') || '').trim().toLowerCase();
  if (!topic || !['reddit', 'x', 'amazon'].includes(source)) {
    sendJson(res, 400, { error: 'Use /api/research?source=reddit|x|amazon&topic=product' });
    return;
  }

  try {
    const payload = source === 'reddit'
      ? await redditResearch(topic)
      : source === 'x'
        ? await xResearch(topic)
        : await amazonResearch(topic);
    sendJson(res, 200, { ...payload, fetchedAt: new Date().toISOString() });
  } catch (e) {
    sendJson(res, 502, { source, topic, error: String(e.message || e), text: '', items: [], count: 0 });
  }
}

export default async function handler(req, res) {
  const url = new URL(req.url || '/api/generate', 'https://' + (req.headers.host || 'localhost'));
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }
  if (url.pathname.endsWith('/research')) {
    await handleResearch(req, res, url);
    return;
  }
  await handleGenerate(req, res, url);
}
