# Private Cloud Gallery

An Angular gallery with:

- real email/password login
- an `owner` role that can upload and delete photos
- a `viewer` role that can only browse photos
- private cloud storage through Supabase Storage
- HEIC/HEIF conversion before upload

## Setup

1. Install dependencies:

```bash
npm install
```

2. Open `src/app/cloud-gallery.config.ts` and replace the placeholder values with:

- your Supabase project URL
- your Supabase anon key

3. In Supabase SQL Editor, run:

- `supabase/gallery-setup.sql`

4. Before running that SQL in production, replace the example emails at the bottom of the file:

- `owner@example.com`
- `viewer@example.com`

5. In Supabase Auth, create or sign up those two accounts from the app.

6. Start the app:

```bash
npm start
```

Open [http://localhost:4200](http://localhost:4200).

In this workspace, `npm start` was verified successfully on April 9, 2026.

## Privacy model

This version is private because:

- authentication is required
- the storage bucket is private
- row-level policies allow only the owner or viewer accounts to read the gallery
- only the owner account can upload or delete photos

Important limits:

- this is not end-to-end encrypted
- Supabase project admins can still access stored data
- if your anon key, RLS policies, or bucket settings are misconfigured, privacy can break

## Build

```bash
npm run build
```

Note: in this environment, `ng build` crashed under Node `v22.7.0` with a native
malloc error even though the Angular compiler and tests passed. If you hit the
same issue locally, switch to Node 20 LTS before creating a production build.

## Deploy on Vercel

This project is prepared for Vercel with `vercel.json`
and a Node 20 pin in `package.json`.

1. Push this project to GitHub.
2. In Vercel, click `Add New` -> `Project` and import the GitHub repo.
3. Keep these settings:
   - Framework preset: `Angular`
   - Build command: `npm run build`
   - Output directory: `dist/romantic-gallery/browser`
   - Node.js version: `20.x`
4. Deploy.
5. Copy the Vercel URL, for example `https://your-gallery.vercel.app`.
6. In Supabase, open `Authentication` -> `URL Configuration`.
7. Set `Site URL` to your Vercel URL.
8. Add these `Redirect URLs`:
   - your Vercel URL
   - `http://localhost:4200`
   - any other local port you use while testing

The signup flow now sends confirmation emails back to the current site origin, so
after deployment the email confirmation link will come back to your Vercel app.

## Test

```bash
npm test
```

## Next privacy upgrade ideas

- add end-to-end encryption before upload
- add password reset and invite flow for the viewer account
- add album support and expiring private share links
