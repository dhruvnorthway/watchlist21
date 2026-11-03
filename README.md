# The Watchlist V2

A quality-first discovery layer on YouTube. It finds videos related to your interests, filters obvious noise, assesses promising candidates, ranks them, and publishes a static grid. Every card links to YouTube. Your feedback stays in your browser.

## V2 changes

- Quality-led scoring: substance, expertise signals, originality, explanatory intent, evidence signals and topic relevance.
- Fully free deterministic quality assessment. No OpenAI key, paid model, or additional API subscription is required.
- Quality assessment runs locally in GitHub Actions with no AI service calls.
- Topic matching now uses whole-keyword boundaries and a longer description window to reduce accidental partial-word matches.
- Search accepts all video durations; the local filter controls the allowed range. This allows useful 8–20 minute explainers that YouTube's `long` filter previously excluded.
- Quality assessment basis and confidence are stored with each video for transparency.
- No views, likes or subscriber counts are used as quality signals.

## How it works

1. GitHub Actions runs at 06:00 and 18:00 India time. It searches a rotating set of topics through the official YouTube Data API.
2. Candidate metadata is fetched and checked against language, region, duration, live/private, title and topic rules.
3. New candidates receive a deterministic quality estimate using title specificity, description structure, chapters, format signals, caption availability and topic relevance.
4. The highest quality and most relevant candidates are scored and saved to `data/videos.json`.
5. GitHub Pages publishes the static site. Browser feedback nudges future ordering and remains local to that browser.

### Important limitation

This release uses deterministic metadata signals, not an LLM. It does **not** watch videos or reliably understand their full content. Duration, chapters, descriptions and captions are imperfect proxies, so quality scores are estimates rather than guarantees. Transcript-level evaluation and richer creator profiles are planned follow-on work.

## Setup

### 1. GitHub repository

Upload the project files to a public GitHub repository, including `.github/workflows/site.yml`. Keep the folder structure intact.

### 2. YouTube API key

Create a Google Cloud project, enable **YouTube Data API v3**, create an API key, and restrict it to YouTube Data API v3. Add it to the repository under **Settings → Secrets and variables → Actions → New repository secret**:

- Name: `YT_API_KEY`
- Value: your YouTube API key

### 3. No paid AI setup required

Only the existing `YT_API_KEY` secret is needed. This upgrade does not call OpenAI or any paid AI service.

### 4. GitHub Pages

In repository **Settings → Pages**, set the source to **GitHub Actions**. In **Settings → Actions → General → Workflow permissions**, allow read and write permissions so the workflow can commit updated video data.

### 5. Run

Open **Actions → Update and publish → Run workflow**. When the build and deploy jobs finish successfully, the site is available at:

`https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/`

The scheduled runs happen at 06:00 and 18:00 India time.

## Make it yours

Edit `config/interests.json` to change topics, queries, keywords, exclusions, duration limits, regional settings and trusted channels. Keep keyword lists specific. Broad single words tend to create noisy matches.

Trusted channels can be configured by channel ID or handle:

```json
"trustedChannels": [
  { "name": "Channel name", "handle": "@theirhandle" }
]
```

## Local development

Requires Node.js 22 or newer.

```bash
npm test
YT_API_KEY=your_key npm run update
npm run serve
```

Open `http://localhost:8080`.

## Data and privacy

The public site reveals the topics and videos in your list. The YouTube API key is used only by GitHub Actions and is not included in the static site. No AI provider receives your video data in this release. Do not add private or sensitive data to the project.

Feedback and opened history are stored in local browser storage and are not sent to GitHub.
