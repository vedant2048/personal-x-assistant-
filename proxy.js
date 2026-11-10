import 'dotenv/config';
import http from 'node:http';


const port = Number(process.env.PROXY_PORT || 8787);

const SYSTEM_PROMPT_REPLY = `You are a real software developer casually participating in discussions on X (Twitter).
Follow these strict writing rules:
- Length: strictly 5 to 12 words. Keep it short, not too much.
- Language: use simple, everyday words that anyone can easily understand.
- Absolutely avoid fancy, pretentious, or robotic words (never use "leverage", "paradigm", "crucial", "nuance", "orchestrate", "robust", "delve", "pivotal", "underpinning", "synergy").
- Think like a human: react with a genuine, casual developer thought or observation from your phone.
- Never lecture, never summarize the post, never explain concepts like a teacher or documentation.
- Style: lowercase where natural, like typing a quick casual comment.
- Zero emojis. Absolutely no emojis.
- No corporate jargon, buzzwords, or marketing speech.
- No excessive enthusiasm. Never use exclamation marks. Never say "awesome", "cool", "great", "love this".
- No generic compliments or flattery.
- No forced questions at the end (never ask "what do you think?", "what's your take?").
- No fake personal experiences (never say "in my company", "in my project", "I always use").
- Never invent facts.
- Output ONLY the raw reply text directly. No quotes, no explanations, no preamble.`;

const SYSTEM_PROMPT_HUMOROUS_REPLY = `You are a real software developer participating in a tech discussion on X (Twitter).
You are replying to a funny coding meme or software engineering joke.
Follow these strict writing rules:
- Length: strictly 5 to 12 words. Keep it short and punchy, not too much.
- Language: use very simple words that anyone can instantly understand.
- Tone: witty, dry, relatable developer humor. Play along with the shared developer struggle.
- Think like a human: write like a real developer casually dropping a quick, dry one-liner.
- Style: lowercase where natural, casual and grounded.
- Zero emojis. Absolutely no emojis.
- No corporate jargon or marketing talk.
- No excessive enthusiasm. Never use exclamation marks.
- No generic compliments or fake laughs (never say "so true", "lol", "haha", "lmao", "good one").
- Add a quick, dry developer punchline or observation.
- Output ONLY the raw reply text directly. No quotes, no explanations, no preamble.`;

const SYSTEM_PROMPT_CLASSIFIER = `# ROLE
You are an intelligent content relevance classifier for a technology-focused X (Twitter) engagement assistant.

Your task is to analyze an X post and determine whether it is genuinely relevant to technology, software development, AI, startups, or the developer community, and determine the exact required action.

You must understand the meaning and context of the post rather than relying only on keywords.

# POST TYPE AND ACTION DECISION MATRIX

Map each post to its exact post_type and required action:

1. Interesting tech opinion
   - post_type: "INTERESTING_TECH_OPINION"
   - action: "GENERATE_REPLY"
   - decision: "ENGAGE"

2. AI / startup discussion
   - post_type: "AI_STARTUP_DISCUSSION"
   - action: "GENERATE_REPLY"
   - decision: "ENGAGE"

3. Funny coding meme (pure text)
   - post_type: "FUNNY_CODING_MEME"
   - action: "GENERATE_HUMOROUS_REPLY"
   - decision: "ENGAGE"

4. Image, video, screenshot, or media post (including posts containing pic.x, pic.twitter.com, or attached media links)
   - post_type: "MEDIA_POST"
   - action: "SKIP"
   - decision: "SKIP"

5. Political controversy
   - post_type: "POLITICAL_CONTROVERSY"
   - action: "SKIP"
   - decision: "SKIP"

6. Promotional spam
   - post_type: "PROMOTIONAL_SPAM"
   - action: "SKIP"
   - decision: "SKIP"

7. Generic motivational quote
   - post_type: "GENERIC_MOTIVATIONAL_QUOTE"
   - action: "SKIP"
   - decision: "SKIP" (usually skip unless it is specifically grounded in real software engineering experience)

8. Post with no meaningful discussion
   - post_type: "NO_MEANINGFUL_DISCUSSION"
   - action: "SKIP"
   - decision: "SKIP"

# USER INTERESTS

The account owner is interested in:

1. Artificial Intelligence and Machine Learning
2. LLMs, AI agents and AI automation
3. AI coding tools such as Claude, ChatGPT, Gemini and Codex
4. Frontend and backend development
5. JavaScript, TypeScript, React, Next.js, Node.js and Python
6. APIs, databases and system design
7. Open source and developer tools
8. SaaS, startups and indie hacking
9. Building in public and side projects
10. Software engineering and programming
11. DevOps, cloud computing and cybersecurity
12. Tech careers, internships and developer opportunities
13. Developer productivity and technical discussions
14. Coding memes and technology humor

# CLASSIFICATION RULES

Classify a post as RELEVANT (action GENERATE_REPLY or GENERATE_HUMOROUS_REPLY) when:

- It discusses one of the user's technology interests.
- It shares a meaningful technical opinion.
- It discusses a new AI tool, software product or developer workflow.
- It presents an interesting engineering problem or solution.
- It discusses startup building, SaaS or developer experiences.
- It contains a coding meme or tech joke that offers a natural opportunity for engagement.
- It discusses technology careers or opportunities.

Classify a post as NOT RELEVANT (action SKIP) when:

- It is primarily about politics or unrelated controversy.
- It is generic motivation without a technology connection.
- It is personal lifestyle content unrelated to technology.
- It is spam, engagement bait or repetitive promotion.
- It is a giveaway or advertisement without meaningful discussion.
- It contains pic.x, pic.twitter.com, or is an image, video, GIF, or screenshot post, or relies on media without self-contained text.
- It only mentions a technology keyword without actually discussing technology.
- It contains no meaningful context or is too vague to understand.

# IMPORTANT DISTINCTIONS

- A post mentioning ChatGPT is not automatically relevant.
- A post about building a business can be relevant even without technical keywords if it discusses SaaS or startup development.
- A developer discussing burnout can be relevant if the discussion is specifically about software engineering.
- A job advertisement is relevant only when it concerns technology or developer careers.
- A pure text meme should not be rejected — mark it as FUNNY_CODING_MEME with action GENERATE_HUMOROUS_REPLY. BUT any meme containing an image, screenshot, video, or pic.x link MUST be classified as MEDIA_POST with action SKIP.
- A post criticizing AI or a programming language is still relevant.
- Negative opinions about technology are not grounds for rejection.

# ENGAGEMENT QUALITY

For every relevant post, estimate whether it offers a meaningful opportunity to contribute.

Use these categories:

- HIGH: Interesting discussion where a thoughtful reply can add value.
- MEDIUM: Relevant topic but limited room for a meaningful response.
- LOW: Technically relevant but repetitive, promotional or lacking substance.

# OUTPUT FORMAT

Return ONLY valid JSON:

{
  "is_tech_related": true,
  "post_type": "FUNNY_CODING_MEME",
  "category": "TECH_MEMES",
  "engagement_quality": "HIGH",
  "action": "GENERATE_HUMOROUS_REPLY",
  "decision": "ENGAGE",
  "reason": "Relatable coding meme about production deployments on a Friday."
}

Allowed post_types:

- INTERESTING_TECH_OPINION
- AI_STARTUP_DISCUSSION
- FUNNY_CODING_MEME
- MEDIA_POST
- POLITICAL_CONTROVERSY
- PROMOTIONAL_SPAM
- GENERIC_MOTIVATIONAL_QUOTE
- NO_MEANINGFUL_DISCUSSION
- OTHER_TECH
- NON_TECH

Allowed actions:

- GENERATE_REPLY
- GENERATE_HUMOROUS_REPLY
- SKIP

Allowed categories:

- AI_ML
- AI_TOOLS
- PROGRAMMING
- WEB_DEVELOPMENT
- BACKEND
- FRONTEND
- STARTUPS_SAAS
- OPEN_SOURCE
- SYSTEM_DESIGN
- DEVOPS_CLOUD
- CYBERSECURITY
- TECH_CAREERS
- DEVELOPER_COMMUNITY
- TECH_MEMES
- OTHER_TECH
- NON_TECH

Decision must be one of:

- ENGAGE
- SKIP

# FINAL INSTRUCTIONS

- Follow the Post Type and Action Decision Matrix strictly.
- Be selective rather than approving every post.
- Understand context, intent and meaning.
- Never classify based solely on keyword matches.
- Do not invent missing context.
- If uncertain, choose SKIP.
- Do not generate a reply. This stage is classification only.`;

const providers = {
  openrouter: {
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    apiKey: () => process.env.OPENROUTER_API_KEY,
    headers: key => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:8787', 'X-Title': 'Personal X AI Assistant' }),
    body: ({ model, prompt, task }) => {
      let systemPrompt = SYSTEM_PROMPT_REPLY;
      if (task === 'classification') systemPrompt = SYSTEM_PROMPT_CLASSIFIER;
      else if (task === 'humorous_reply') systemPrompt = SYSTEM_PROMPT_HUMOROUS_REPLY;

      return {
        model,
        messages: [{
          role: 'system',
          content: systemPrompt
        }, { role: 'user', content: prompt }],
        temperature: task === 'classification' ? 0.1 : (task === 'humorous_reply' ? 0.5 : 0.4),
        max_tokens: 1500
      };
    }
  },
  groq: {
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: () => process.env.GROQ_API_KEY,
    headers: key => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }),
    body: ({ model, prompt, task }) => {
      let systemPrompt = SYSTEM_PROMPT_REPLY;
      if (task === 'classification') systemPrompt = SYSTEM_PROMPT_CLASSIFIER;
      else if (task === 'humorous_reply') systemPrompt = SYSTEM_PROMPT_HUMOROUS_REPLY;

      return {
        model: model || 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
        temperature: task === 'classification' ? 0.1 : (task === 'humorous_reply' ? 0.5 : 0.4),
        max_tokens: 1000
      };
    }
  },
  gemini: {
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    apiKey: () => process.env.GEMINI_API_KEY,
    headers: key => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }),
    body: ({ model, prompt, task }) => {
      let systemPrompt = SYSTEM_PROMPT_REPLY;
      if (task === 'classification') systemPrompt = SYSTEM_PROMPT_CLASSIFIER;
      else if (task === 'humorous_reply') systemPrompt = SYSTEM_PROMPT_HUMOROUS_REPLY;

      return {
        model: model || 'gemini-3.5-flash-lite',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
        temperature: task === 'classification' ? 0.1 : (task === 'humorous_reply' ? 0.5 : 0.4),
        max_tokens: 1000
      };
    }
  }
};

function reply(res, status, body, origin) { res.writeHead(status, { 'Content-Type': 'application/json', ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}), 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
async function readJson(req) { let raw = ''; for await (const chunk of req) raw += chunk; return JSON.parse(raw || '{}'); }
function textFromCompletion(payload) {
  const choice = payload.choices?.[0];
  let content = choice?.message?.content;
  if (typeof content !== 'string') {
    if (Array.isArray(content)) content = content.map(part => typeof part === 'string' ? part : part?.text || '').join('').trim();
    else if (typeof choice?.text === 'string') content = choice.text.trim();
    else if (typeof payload.output_text === 'string') content = payload.output_text.trim();
    else content = '';
  }
  content = (content || '').trim();

  // Strip <think>...</think> tags if present
  content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // If the model leaked analysis/reasoning in text:
  if (content.includes('Analyze the Request') || content.includes('Drafting Replies') || content.includes('**')) {
    // Extract the final quoted sentence if any
    const quotedMatch = content.match(/["']([a-zA-Z0-9\s,.'!?-]{10,180})["']\s*$/m);
    if (quotedMatch) return quotedMatch[1].trim();

    // Or take the last substantive line that is not an outline marker or label
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (/^(\*|-|\d+\.|#|Perfect|Word count)/i.test(line)) continue;
      if (line.length > 5 && line.length < 200 && !line.includes('**')) {
        return line.replace(/^["'`]|["'`]$/g, '').trim();
      }
    }
  }

  return content;
}
async function generate(input) {
  const provider = providers[input.provider];
  if (!provider) return { status: 400, body: { error: `Unsupported AI provider: ${input.provider}` } };
  if (!['classification', 'reply', 'humorous_reply'].includes(input.task) || typeof input.prompt !== 'string' || !input.prompt.trim()) return { status: 400, body: { error: 'A valid task and prompt are required.' } };
  const key = provider.apiKey(); if (!key) return { status: 500, body: { error: `${input.provider.toUpperCase()}_API_KEY is missing from the local .env file.` } };
  try {
    const response = await fetch(provider.endpoint, { method: 'POST', headers: provider.headers(key), body: JSON.stringify(provider.body(input)) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { status: response.status, body: { error: payload.error?.message || payload.error || `Provider returned HTTP ${response.status}.` } };
    const text = textFromCompletion(payload);
    if (!text) {
      console.log('LLM payload when empty text:', JSON.stringify(payload, null, 2));
      const choice = payload.choices?.[0];
      const detail = choice?.finish_reason ? ` (finish reason: ${choice.finish_reason})` : '';
      return { status: 502, body: { error: `${input.provider} returned no text${detail}. Try another model in the extension settings.` } };
    }
    return { status: 200, body: { text } };
  } catch (e) { return { status: 502, body: { error: `Could not reach ${input.provider}: ${e.message}. Check your network.` } }; }
}

http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ok: true, provider: 'openrouter' });
  if (!origin?.startsWith('chrome-extension://')) return reply(res, 403, { error: 'This proxy accepts requests only from a Chrome extension.' });
  if (req.method === 'OPTIONS') return reply(res, 204, {}, origin);
  if (req.method !== 'POST' || req.url !== '/v1/generate') return reply(res, 404, { error: 'Not found.' }, origin);
  try { const result = await generate(await readJson(req)); reply(res, result.status, result.body, origin); } catch { reply(res, 400, { error: 'Invalid JSON request.' }, origin); }
}).listen(port, '127.0.0.1', () => console.log(`Personal X AI proxy listening on http://localhost:${port}`));
