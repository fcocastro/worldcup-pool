# World Cup 2026 Family Pool 🏆

A small website where your family makes knockout-round predictions, and the
standings update automatically as results come in.

- **Hosting:** GitHub Pages (free)
- **Picks / players / results:** Supabase (free tier)
- **Results:** auto-fetched from a football API by a GitHub Action, with a
  manual **Admin** override built into the site
- **Picks are round-by-round:** a match opens for picking once both its teams
  are known, and locks once the result is in (or at kickoff, if you set one)

## Scoring

| Round | Matches | Points each | Round max |
|-------|---------|-------------|-----------|
| Round of 32 | 16 | 2 | 32 |
| Round of 16 | 8 | 4 | 32 |
| Quarterfinals | 4 | 8 | 32 |
| Semifinals | 2 | 16 | 32 |
| Champion (final) | 1 | 32 | 32 |
| **Total** | | | **160** |

**Tiebreaker:** total goals scored across both semifinals + the final. Used to
break ties (closest guess wins). Each person enters it on the Make Picks tab.

---

## One-time setup (about 15 minutes)

### 1. Create the Supabase database
1. Sign up at [supabase.com](https://supabase.com) → **New project** (free tier is fine).
2. In the project, open **SQL Editor → New query**, paste the entire contents of
   [`supabase-setup.sql`](supabase-setup.sql), and click **Run**. This creates the
   `players`, `picks`, and `results` tables and seeds the two R32 games already final.
3. Open **Project Settings → API** and copy two values:
   - **Project URL** (e.g. `https://abcd1234.supabase.co`)
   - **anon public** key (a long string)
   - Also note the **service_role** key (further down) — you'll need it in step 5.
     Keep this one secret; it bypasses all security.

### 2. Configure the site
Open [`config.js`](config.js) and fill in:
```js
SUPABASE_URL:      "https://abcd1234.supabase.co",   // your Project URL
SUPABASE_ANON_KEY: "eyJ...your anon public key...",
COMMISSIONER_PIN:  "pick-a-secret",                   // YOU use this in the Admin tab
POOL_NAME:         "The Castro Family World Cup"
```

### 3. Import the picks you already have (optional)
Two CSVs live in [`import/`](import/). Import them in Supabase via
**Table Editor → (table) → Insert → Import data from CSV**.

1. **Players first** — [`import/players-import-template.csv`](import/players-import-template.csv):
   columns `name, pin, tiebreaker`. Give each person a PIN (any number/word) and
   share it with them so they can edit their own picks later. Leave `tiebreaker` blank for now.
2. **Then picks** — [`import/picks-import-template.csv`](import/picks-import-template.csv):
   columns `player, match_id, pick`. `player` must exactly match a name from the
   players file. `pick` is the team name they chose. `match_id` is the FIFA match
   number from the table below.

Use the exact team-name spellings shown below so scoring matches.

#### Round of 32 match reference
| # | Match | # | Match |
|---|-------|---|-------|
| 73 | Canada vs South Africa | 81 | United States vs Bosnia and Herzegovina |
| 74 | Germany vs Paraguay | 82 | Belgium vs Senegal |
| 75 | Netherlands vs Morocco | 83 | Portugal vs Croatia |
| 76 | Brazil vs Japan | 84 | Spain vs Austria |
| 77 | France vs Sweden | 85 | Switzerland vs Algeria |
| 78 | Ivory Coast vs Norway | 86 | Argentina vs Cape Verde |
| 79 | Mexico vs Ecuador | 87 | Colombia vs Ghana |
| 80 | England vs DR Congo | 88 | Australia vs Egypt |

Matches **89–96** are the Round of 16, **97–100** quarterfinals, **101–102**
semifinals, **103** the final. Their teams fill in automatically from earlier
results, so you can only import/enter picks for them once those teams are known
(that's the round-by-round design).

### 4. Publish the site on GitHub Pages
1. Create a new GitHub repo and upload everything in this folder (the whole
   `worldcup-pool` directory contents).
2. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a
   branch**, branch `main`, folder `/ (root)`. Save.
3. After a minute your site is live at
   `https://YOUR-USERNAME.github.io/YOUR-REPO/`. Share that link with the family.

### 5. Turn on automatic results
1. Get a free API token at [football-data.org](https://www.football-data.org/client/register).
2. In your GitHub repo: **Settings → Secrets and variables → Actions → New
   repository secret**, and add three secrets:
   - `FOOTBALL_DATA_TOKEN` — the token from step 1
   - `SUPABASE_URL` — your Project URL
   - `SUPABASE_SERVICE_KEY` — the **service_role** key from Supabase (step 1)
3. The workflow in [`.github/workflows/fetch-results.yml`](.github/workflows/fetch-results.yml)
   runs every 3 hours. To run it immediately: repo **Actions** tab → *Fetch World
   Cup results* → **Run workflow**.

> ⚠️ **Reality check on the API:** the free football-data tier may not fully
> cover the World Cup, team names sometimes differ, and **knockout games decided
> on penalties** can't be read automatically. When that happens the site just
> won't have a winner yet — fix it in **5 seconds** via the Admin tab. The pool
> never depends on the API working.

---

## Day-to-day use

**Family members:**
1. Open the site → **Make Picks** tab.
2. Enter their **name + PIN** (first-timers choose a PIN; it locks their picks to them).
3. Tap the team they think wins each open match. Picks save instantly.
4. Enter the **tiebreaker** (total goals in both semis + final).
5. Watch **Standings**.

**You (commissioner):**
- Results usually arrive on their own. To set/fix one: **Admin** tab → enter your
  commissioner PIN → choose the winner + scores for a match → **Save**.
- When you enter a winner, that match locks and the next round's teams appear
  automatically.
- Optionally add real **kickoff** times in [`data/bracket.json`](data/bracket.json)
  (the `kickoff` field, ISO format like `2026-07-03T19:00:00Z`) so picks lock at
  kickoff instead of when the result is entered — fairer for round-by-round.

---

## Notes & limitations
- **Security is family-grade, not bank-grade.** The anon key and PINs live in the
  browser; PINs stop accidental overwrites, not a determined relative. That's the
  right trade-off for a family pool. (To harden later, enable stricter Supabase
  RLS policies.)
- **Scores** are only needed for the tiebreaker; winners are all that scoring uses.
- **Team-name spelling** must be consistent between picks and results — stick to
  the spellings in the reference table.
- Want to test locally before deploying? Run `python3 -m http.server` in this
  folder and open `http://localhost:8000` (a plain double-click won't work because
  the page fetches `bracket.json`).
