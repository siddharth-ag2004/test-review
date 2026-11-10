# Test Review: setup (about 15 minutes, all free)

The site is just static files, so any free host works. You only do this once.
Until you do step 1 to 3, the site still works but saves tests **only in that one browser**.
Do the steps below so that your father can use it from his Windows laptop and keep a shared library.

## 1. Create the free database and login (Supabase)
1. Go to https://supabase.com, sign up, and click **New project** (any name, any region close to you, pick a database password and save it).
2. Open **SQL Editor > New query**, paste the whole of `supabase-setup.sql`, and click **Run**.
3. Open **Authentication > Users > Add user > Create new user**. Enter an email and password for the family (tick **Auto Confirm User**). Use this to sign in.
4. Open **Authentication > Sign In / Providers** (or **Settings**) and turn **off** "Allow new users to sign up", so only that login works.
5. Open **Project Settings > API** and copy two things: the **Project URL** and the **anon public** key.

## 2. Put the keys in the site
Copy `config.example.js` to `config.js` (it is not stored in git), open `config.js`, and paste them between the quotes:

```js
export const SUPABASE_URL = "https://xxxx.supabase.co";
export const SUPABASE_ANON_KEY = "eyJ...";
```
The anon key is meant to be public. The data stays private because the SQL above only allows signed-in users.

## 3. Put the site online (pick one)
Upload everything in this folder **except** the `_test` folder (delete it if it is still there).
- **Netlify** (easiest): go to https://app.netlify.com/drop and drag this folder onto the page. You get a link like `https://something.netlify.app`.
- **Cloudflare Pages** or **GitHub Pages** work the same way.

## 4. Tell your father
1. Open the link in Chrome or Edge and sign in. Bookmark the page.
2. Click **+ New test**. Type the title (for example "10 Nov Maths ADV SC P1") and choose the subject.
3. Drag in all the photos from the phone, in any order. Wait a few seconds while it reads them (the first time can take a minute).
4. For each photo, press **Partial / Wrong / Skipped** (or keys 1, 2, 3, which jump to the next photo). Check the **Q** number. If it is highlighted yellow, it was read automatically and should be double-checked.
5. If a crop is wrong, click the photo and drag the blue edges. **⟲ ⟳** rotates a photo.
6. Click **Save to library**. In the **Library** he can download the Word doc at any time, reopen a test to change it, or delete it.

## Notes
- Photos are read inside the browser, so they never go to any AI service.
- If "Solution" is not found on a photo, a red note appears on it. Check the crop on those.
- Supabase's free plan holds about 1 GB (a few thousand photos). It pauses a project after a week of no use, and it wakes up from the Supabase dashboard with one click.
