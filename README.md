# Personal X AI Assistant

A Manifest V3 Chrome extension that watches posts you scroll into view on X, checks their technology relevance, and creates one concise reply draft for relevant posts. It does not scroll the feed itself.

AI requests go through a small local Node.js proxy. The proxy calls OpenRouter using `openrouter/free`; the API key stays in the local `.env` file and is never available to the extension. The proxy binds only to `127.0.0.1` and accepts API requests only from Chrome extension origins.

## Install

1. Install Node.js 18 or later.
2. In this folder, install the proxy dependency:

   ```powershell
   npm install
   ```

3. Copy `.env.example` to `.env`, then add your OpenRouter API key:

   ```text
   OPENROUTER_API_KEY=your_key_here
   ```

4. Start the local proxy and keep its terminal open:

   ```powershell
   npm start
   ```

5. In Chrome, open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, then select this folder.
6. Open an X page, open the extension popup, and choose **Start**.

The first visible post is queued immediately. Posts that become visible as you scroll are queued afterwards. The worker selects a random delay between 150 and 180 seconds before each processing attempt.

## Settings

`openrouter/free` is the default model router. Change the model field in the popup to any OpenRouter model ID your API key may use. The extension has no OpenRouter credential setting because keys belong only in `.env`.

## Request flow and caching

- The extension sends an abstract `classification` or `reply` task to `http://localhost:8787/v1/generate`.
- The proxy implements the OpenRouter provider at `https://openrouter.ai/api/v1/chat/completions`. Add a provider adapter in `proxy.js` for Hugging Face or Groq without changing the extension workflow.
- Each post's classification is saved in IndexedDB. Regeneration reuses that result and sends only a new reply request. Duplicate post IDs are skipped.
- The proxy passes rate limits (HTTP 429), unavailable models (HTTP 404), provider failures, empty output, and network errors back to the popup in readable form.
- Requests disable model reasoning and reserve enough output tokens for the actual classification or reply; the extension still truncates replies to 280 characters.

## Publishing replies

Enable **automatic submission** in Settings to reveal **Confirm & submit**. The popup asks for confirmation for every draft, then finds X's reply UI and posts it. Start and scrolling do not publish replies. Pausing or stopping blocks submission.

X can change its DOM at any time. If the extension reports that a control or editor could not be found, reload the X tab and update selectors in `content.js` if needed.
