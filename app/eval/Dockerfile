# SPEC-0042 EVAL Slice-1 — clean-world eval container (EVAL-5). Pins node + the app/eval deps + the BYOA
# `copilot` CLI (@github/copilot, installed by `npm ci` from the lockfile, linux-x64 binary) + git, so a
# result is re-runnable. Build context = the `app/` dir:  docker build -f eval/Dockerfile -t kb-eval .
#
# CRED-FREE (fork #4 / AUTO-11 / EVAL-11): NO secrets are baked into the image — `ARG`/`ENV` carry no
# creds, nothing is COPYed in. Scoped eval BYOA creds are injected ONLY at run time, e.g.:
#   docker run --rm -e COPILOT_TOKEN=<scoped-eval-token> kb-eval
# so the image stays freely shareable and the Principal's creds never enter it.
FROM node:22.23.4-bookworm-slim

# git is a hard runtime dep — the pipeline + staging worktrees shell out to it.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Deps first (layer-cached, reproducible from the lockfile). `npm ci` installs @github/copilot — the BYOA
# `copilot` CLI binary into node_modules/.bin — pinned by package-lock.json.
COPY package.json package-lock.json ./
RUN npm ci

# App + eval sources (node_modules/.git/build output excluded via .dockerignore).
COPY . .

# Make the BYOA `copilot` CLI resolvable on PATH (the SDK resolves `copilot` off PATH); enable the opt-in eval.
ENV PATH="/app/node_modules/.bin:${PATH}"
ENV KB_EVAL=1

# Runs the opt-in scenario evals (real cognition) — emits the scorecard. Scoped eval creds come at run time.
ENTRYPOINT ["npm", "run", "eval:enrich"]
