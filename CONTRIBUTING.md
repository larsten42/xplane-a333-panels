# Contributing

Thanks for wanting to help verify or improve something here — this covers
how to send a change back for review, if you haven't used GitHub for that
before. The short version: you make your changes on your own copy of the
repo, then open a **Pull Request** (PR) asking to merge them in. Nothing
lands in the real project until that PR is reviewed and merged — so there's
no way to "break" anything by trying.

There are two ways to do this, depending on what you're changing.

## Option A — small edits, straight from the browser (no installs)

Good for: fixing a dataref/command name in a `config/profiles/*.json` file,
a typo, a doc correction — anything you can type directly into a text box.

1. Open the file you want to change on GitHub (e.g.
   [`config/profiles/efis-toliss-airbus.json`](https://github.com/larsten42/xplane-a333-panels/blob/main/config/profiles/efis-toliss-airbus.json)).
2. Click the pencil icon (**Edit this file**) in the top right of the file view.
   - First time editing a repo you don't own: GitHub automatically creates
     your own copy (a "fork") behind the scenes and puts you in it — you
     don't need to do anything extra for that part.
3. Make your change directly in the browser's text editor.
4. Scroll down to **"Propose changes"**. Write a short description of what
   you changed and why (e.g. "Confirmed AirbusFBW/BRG1Selector live against
   ToLiss A330").
5. Click **Propose changes**, then **Create pull request** on the next
   screen.

That's it — the PR shows up on the real repo, and I'll get notified.

## Option B — bigger changes, or if you want to run the app locally

Good for: testing the actual panel against your own X-Plane session,
running `tools/discover.mjs`, changing multiple files, or anything you want
to try out before sending.

**One-time setup:**

1. Click **Fork** in the top right of the
   [repo's GitHub page](https://github.com/larsten42/xplane-a333-panels) —
   this makes your own copy under your account
   (`github.com/<your-username>/xplane-a333-panels`).
2. Clone *your fork* to your computer (not the original repo):
   ```sh
   git clone https://github.com/<your-username>/xplane-a333-panels.git
   cd xplane-a333-panels
   ```

**For each change you want to make:**

3. Create a branch for it (keeps your change separate from anything else):
   ```sh
   git checkout -b fix-toliss-brg
   ```
4. Make your edits — with an editor, or by running the app locally
   (`node tools/mcdu-server.js`, see the main [README](README.md)) and
   `tools/discover.mjs` to find real dataref/command names against a live
   session.
5. Commit and push to *your fork*:
   ```sh
   git add -A
   git commit -m "Confirm ToLiss BRG1/BRG2 datarefs"
   git push -u origin fix-toliss-brg
   ```
6. GitHub will print a URL after that push — open it, or go to your fork's
   page, and click **Compare & pull request**. Describe what you changed
   and why, then **Create pull request**.

## What happens after you open a PR

The PR shows up as a diff against the real project — I (or whoever's
reviewing) can see exactly what changed, comment on specific lines, and
run/test it before anything is merged. If something needs adjusting, just
push more commits to the same branch — they'll automatically show up in
the same PR. Nothing you do in your own fork affects the real repo until
the PR is actually merged, so it's completely safe to experiment.

If you get stuck at any point, open the PR anyway with whatever you have
and a note about what's not working — half-finished is genuinely fine to
send, that's what review is for.
