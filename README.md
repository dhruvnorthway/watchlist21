# The Watchlist

A personal layer on YouTube. It finds videos that match your interests, ranks them with its own rules, and shows a grid of thumbnails and titles. Every card links to YouTube. It refreshes itself twice a day.

## How it works

1. A job on GitHub runs at 06:00 and 18:00 India time. It asks the official YouTube Data API for videos on your topics, drops anything that fails your filters, scores the rest and saves `data/videos.json`.
2. A static page (`index.html`) reads that file and shows the list. Nothing else runs.
3. Your "More like this" and "Not for me" clicks are saved in your browser and gently reorder the list. They never leave your browser.

## Set it up (about 15 minutes)

**1. Put the files on GitHub.** Create a new repository (public, because free GitHub Pages needs that) and upload everything in this folder, including the hidden `.github` folder. On a Mac press Cmd+Shift+. in Finder to see hidden folders. If the web uploader skips `.github`, create the file `.github/workflows/site.yml` by hand with "Add file", "Create new file", and paste in its contents.

**2. Get a YouTube API key (free).**
- Go to console.cloud.google.com and create a project.
- Open "APIs and services", then "Library", search for **YouTube Data API v3** and click Enable.
- Open "Credentials", choose "Create credentials", then "API key".
- Click the key, and under "API restrictions" restrict it to YouTube Data API v3.

**3. Save the key as a secret.** In your repository open Settings, then "Secrets and variables", then "Actions", then "New repository secret". Name it `YT_API_KEY` and paste the key. The key stays on GitHub and is never put in the page.

**4. Turn on Pages.** In Settings open "Pages" and set the source to **GitHub Actions**. Do this before the first run.

**5. Run it.** Open the Actions tab, choose "Update and publish", then "Run workflow". When it finishes, your site is at `https://YOUR-USERNAME.github.io/YOUR-REPO/`.

Each run searches 35 of your 68 topics, so the whole list fills in over the first day. A run uses about 3,600 of your 10,000 free daily API units, so the two scheduled runs use about 7,200. That leaves room for one extra manual run per day. If the daily limit is reached, the job stops early, keeps your existing list and carries on at the next run.

If a run fails, open it in the Actions tab. The error message says what went wrong, for example a missing secret or an API that was not enabled.

## Make it yours

Everything you would change is in `config/interests.json`.

- **Topics.** Each topic has search phrases (`q`) and keywords (`k`). A video is only kept if its title and description match enough keywords of one of your topics. That is how the list stays on your interests only.
- **Trusted channels.** Add channels whose new uploads you always want to see. They get a score boost and fill the "Trusted channel" slots.

```json
"trustedChannels": [
  { "name": "Channel name", "handle": "@theirhandle" }
]
```

- **Exclusions.** `excludeTitle` and `clickbaitPhrases` hold the patterns for motivational content, reaction videos, gossip, outrage, shorts and clickbait. Add or remove patterns freely.
- **Settings.** Region, shortest and longest video length, how many searches per run, and the 50/25/25 split.

## How videos are chosen and ranked

A video is dropped if it is private, live, a Short, too short, blocked in India, in another language, off your topics, or clickbait.

The score is made of how well it matches your topics, how deep it looks (length, chapters in the description, captions), how recent it is, and a boost for trusted channels. It never uses views, likes or subscriber counts.

In the browser your feedback adjusts the score slightly. One "Not for me" hides that video and lowers its channel a little. It does not remove a whole subject.

The "For You" order follows your 50/25/25 split: half personal picks, a quarter from trusted channels, a quarter unexpected finds from the departments you weight least. Videos you open move to the end of the list.

One limit to know about: the videos come from YouTube search, and YouTube's search ranking is influenced by popularity. This site cannot change that. It filters and re-ranks what YouTube returns, and trusted channels are the best way to surface true hidden gems.

## Privacy

The site is public to anyone with the link. It shows only a list of videos, but it does reveal your interests. Your feedback and opened history stay in your browser.

## Run it on your computer

You need Node 20 or newer.

```
npm test                 # runs the tests, no network needed
YT_API_KEY=your_key npm run update
npm run serve            # then open http://localhost:8080
```

## What is in the folder

- `index.html`, `assets/` the page
- `data/videos.json` the current list, rewritten by each update
- `config/interests.json` your interests and rules
- `scripts/` the update job and the scoring rules
- `.github/workflows/site.yml` the twice daily schedule and publishing
- `test/` automated tests
