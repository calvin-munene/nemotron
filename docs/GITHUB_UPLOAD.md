# Upload a clean copy to GitHub

The repository is **[`calvin-munene/nemotron`](https://github.com/calvin-munene/nemotron)**, private.

Use the clean snapshot procedure below when importing this workspace into a new repository. For routine updates to an existing clean checkout, commit and push from that checkout instead; do not push the original workspace history.

## Why a clean snapshot is required

An uploaded environment file is present in this workspace's Git history. Simply deleting it from the latest commit would still send its old contents to GitHub. Do **not** push this workspace's `main` branch or run `git push --mirror`.

The export helper copies current tracked source files into a new directory without `.git`, uploaded attachments, agent memory, local environment files, private keys, dependencies, or generated output. It does not delete or rewrite the original project.

## 1. Create the empty private repository

Open <https://github.com/new>, select owner `calvin-munene`, enter repository name `nemotron`, and select **Private**. Leave the README, license, and `.gitignore` initialization options unchecked so the repository is empty.

## 2. Make the clean export

From this project's root:

The export helper requires Python 3.9 or later.

```sh
python3 scripts/export-github-snapshot.py
```

The helper writes `generated-artifacts/nemotron-github-export/`. It refuses to overwrite a non-empty directory. For another export, use a different path under `generated-artifacts/`:

```sh
python3 scripts/export-github-snapshot.py --output generated-artifacts/nemotron-github-export-new
```

Review the exported files before pushing. Real credentials belong only in a private server-side environment file, not in this export.

## 3. Push the export, not the original workspace

Use a machine with GitHub SSH authentication already configured for your account. Do not put a token or private key into these commands.

```sh
cd generated-artifacts/nemotron-github-export
git init --initial-branch=main
git add .
git commit -m "Initial clean Nemotron source import with VPS instructions"
git remote add origin git@github.com:calvin-munene/nemotron.git
git push -u origin main
```

If Git asks for an author, configure your Git name and email on that machine before committing. If authentication fails, fix GitHub SSH access or use an approved Git credential manager; never paste credentials into a remote URL.

Once the push succeeds, clone that private repository on the VPS and follow [VPS deployment](VPS_DEPLOYMENT.md). There is intentionally no old project history in the new repository.
