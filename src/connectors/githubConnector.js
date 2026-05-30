// ─────────────────────────────────────────────
// githubConnector.js — GitHub REST connector via @octokit/rest.
//
// Action read/list/check langsung jalan. Action mutating (push, create_pr,
// merge_pr, delete_branch, delete_repo, update_secret, dll) WAJIB approval —
// caller harus pakai approvalPolicy.requiresApproval() dulu.
// ─────────────────────────────────────────────

import { Octokit } from "@octokit/rest";
import { config } from "../core/config.js";
import { logger } from "../core/logger.js";
import { redactSecrets, maskSecret } from "../utils/security.js";

const SAFE_ACTIONS = [
  "ping",
  "get_user",
  "get_repo",
  "list_repos",
  "list_branches",
  "get_branch",
  "list_issues",
  "get_issue",
  "list_pull_requests",
  "get_pull_request",
  "list_workflows",
  "list_workflow_runs",
  "get_workflow_status"
];

const DANGEROUS_ACTIONS = [
  "push",                 // git-level, dijalankan oleh terminal flow setelah approve
  "create_pull_request",
  "merge_pull_request",
  "close_pull_request",
  "delete_branch",
  "delete_repo",
  "update_repo_settings",
  "add_collaborator",
  "remove_collaborator",
  "create_or_update_secret",
  "create_issue",
  "close_issue",
  "comment_issue",
  "dispatch_workflow",
  "create_repo",
  "create_release"
];

let octokit = null;
let lastIdentity = null;

function getOctokit() {
  if (!config.enableGithubConnector) {
    throw new Error("GitHub connector dimatikan. Set ENABLE_GITHUB_CONNECTOR=true di .env.");
  }
  if (!String(config.githubToken || "").trim()) {
    throw new Error("GITHUB_TOKEN belum diisi di .env.");
  }
  if (!octokit) {
    octokit = new Octokit({
      auth: config.githubToken,
      userAgent: "telegram-coding-agent",
      request: { timeout: config.connectorTimeoutMs }
    });
  }
  return octokit;
}

function refreshClient() {
  octokit = null;
  lastIdentity = null;
}

function isEnabled() {
  return config.enableGithubConnector;
}

function describeStatus() {
  return {
    enabled: config.enableGithubConnector,
    hasCredential: Boolean(String(config.githubToken || "").trim()),
    tokenPreview: maskSecret(config.githubToken),
    defaultOwner: config.githubDefaultOwner || null,
    defaultRepo: config.githubDefaultRepo || null,
    lastIdentity: lastIdentity ? lastIdentity.login : null
  };
}

function envHelp() {
  return [
    "Isi `.env` dengan:",
    "`ENABLE_GITHUB_CONNECTOR=true`",
    "`GITHUB_TOKEN=`  (Personal Access Token, scope minimal: repo, read:user, workflow)",
    "`GITHUB_DEFAULT_OWNER=owner`  (opsional)",
    "`GITHUB_DEFAULT_REPO=repo`  (opsional)",
    "Jangan paste token di chat. Edit `.env` langsung."
  ].join("\n");
}

async function safeOctokit(fn) {
  try {
    const client = getOctokit();
    const result = await fn(client);
    return { ok: true, data: result?.data ?? result };
  } catch (err) {
    const status = err?.status || err?.response?.status || null;
    const message = redactSecrets(err?.message || String(err));
    try {
      await logger.warn("GitHub connector error", { status, error: message });
    } catch {}
    return { ok: false, status, error: message };
  }
}

// ─────────────────────────────────────────────
// Public connector API
// ─────────────────────────────────────────────

export const githubConnector = {
  id: "github",
  label: "GitHub",
  allowedActions: SAFE_ACTIONS.slice(),
  dangerousActions: DANGEROUS_ACTIONS.slice(),

  isEnabled,
  refresh: refreshClient,
  envHelp,
  getStatus: describeStatus,

  async testConnection() {
    if (!isEnabled()) {
      return { ok: false, reason: "GitHub connector dimatikan.", help: envHelp() };
    }
    if (!String(config.githubToken || "").trim()) {
      return { ok: false, reason: "GITHUB_TOKEN kosong.", help: envHelp() };
    }
    const res = await safeOctokit((c) => c.rest.users.getAuthenticated());
    if (!res.ok) return { ok: false, reason: res.error, status: res.status };
    lastIdentity = res.data;
    return {
      ok: true,
      identity: {
        login: res.data.login,
        name: res.data.name,
        publicRepos: res.data.public_repos,
        privateRepos: res.data.total_private_repos
      }
    };
  },

  async getUser() {
    const res = await safeOctokit((c) => c.rest.users.getAuthenticated());
    if (!res.ok) return res;
    lastIdentity = res.data;
    return res;
  },

  async listRepos({ perPage = 10, sort = "updated" } = {}) {
    return safeOctokit((c) =>
      c.rest.repos.listForAuthenticatedUser({
        per_page: Math.min(Math.max(parseInt(perPage, 10) || 10, 1), 50),
        sort
      })
    );
  },

  async getRepo({ owner, repo } = {}) {
    const o = owner || config.githubDefaultOwner;
    const r = repo || config.githubDefaultRepo;
    if (!o || !r) return { ok: false, error: "Owner/repo tidak ditentukan dan default kosong." };
    return safeOctokit((c) => c.rest.repos.get({ owner: o, repo: r }));
  },

  async listBranches({ owner, repo, perPage = 20 } = {}) {
    const o = owner || config.githubDefaultOwner;
    const r = repo || config.githubDefaultRepo;
    if (!o || !r) return { ok: false, error: "Owner/repo wajib." };
    return safeOctokit((c) =>
      c.rest.repos.listBranches({ owner: o, repo: r, per_page: Math.min(perPage, 100) })
    );
  },

  async listIssues({ owner, repo, state = "open", perPage = 10 } = {}) {
    const o = owner || config.githubDefaultOwner;
    const r = repo || config.githubDefaultRepo;
    if (!o || !r) return { ok: false, error: "Owner/repo wajib." };
    return safeOctokit((c) =>
      c.rest.issues.listForRepo({ owner: o, repo: r, state, per_page: Math.min(perPage, 50) })
    );
  },

  async listPullRequests({ owner, repo, state = "open", perPage = 10 } = {}) {
    const o = owner || config.githubDefaultOwner;
    const r = repo || config.githubDefaultRepo;
    if (!o || !r) return { ok: false, error: "Owner/repo wajib." };
    return safeOctokit((c) =>
      c.rest.pulls.list({ owner: o, repo: r, state, per_page: Math.min(perPage, 50) })
    );
  },

  async listWorkflows({ owner, repo } = {}) {
    const o = owner || config.githubDefaultOwner;
    const r = repo || config.githubDefaultRepo;
    if (!o || !r) return { ok: false, error: "Owner/repo wajib." };
    return safeOctokit((c) => c.rest.actions.listRepoWorkflows({ owner: o, repo: r }));
  },

  async listWorkflowRuns({ owner, repo, perPage = 5 } = {}) {
    const o = owner || config.githubDefaultOwner;
    const r = repo || config.githubDefaultRepo;
    if (!o || !r) return { ok: false, error: "Owner/repo wajib." };
    return safeOctokit((c) =>
      c.rest.actions.listWorkflowRunsForRepo({ owner: o, repo: r, per_page: Math.min(perPage, 50) })
    );
  },

  // ── Mutating actions (caller WAJIB sudah lewat approval) ──

  async createIssue({ owner, repo, title, body }) {
    const o = owner || config.githubDefaultOwner;
    const r = repo || config.githubDefaultRepo;
    if (!o || !r) return { ok: false, error: "Owner/repo wajib." };
    if (!title) return { ok: false, error: "Title wajib." };
    return safeOctokit((c) =>
      c.rest.issues.create({ owner: o, repo: r, title, body: body || "" })
    );
  },

  async createPullRequest({ owner, repo, title, head, base, body }) {
    const o = owner || config.githubDefaultOwner;
    const r = repo || config.githubDefaultRepo;
    if (!o || !r || !title || !head || !base) {
      return { ok: false, error: "Field wajib: owner, repo, title, head, base." };
    }
    return safeOctokit((c) =>
      c.rest.pulls.create({ owner: o, repo: r, title, head, base, body: body || "" })
    );
  },

  async mergePullRequest({ owner, repo, pullNumber, mergeMethod = "merge" }) {
    const o = owner || config.githubDefaultOwner;
    const r = repo || config.githubDefaultRepo;
    if (!o || !r || !pullNumber) return { ok: false, error: "Field wajib: owner, repo, pullNumber." };
    return safeOctokit((c) =>
      c.rest.pulls.merge({ owner: o, repo: r, pull_number: Number(pullNumber), merge_method: mergeMethod })
    );
  },

  async deleteBranch({ owner, repo, branch }) {
    const o = owner || config.githubDefaultOwner;
    const r = repo || config.githubDefaultRepo;
    if (!o || !r || !branch) return { ok: false, error: "Field wajib: owner, repo, branch." };
    return safeOctokit((c) =>
      c.rest.git.deleteRef({ owner: o, repo: r, ref: `heads/${branch}` })
    );
  },

  async createRepo({ name, description = "", private: isPrivate = true, org = "" } = {}) {
    if (!name) return { ok: false, error: "name wajib." };
    if (org) {
      return safeOctokit((c) =>
        c.rest.repos.createInOrg({
          org,
          name,
          description,
          private: Boolean(isPrivate)
        })
      );
    }
    return safeOctokit((c) =>
      c.rest.repos.createForAuthenticatedUser({
        name,
        description,
        private: Boolean(isPrivate)
      })
    );
  },

  async deleteRepo({ owner, repo } = {}) {
    const o = owner || config.githubDefaultOwner;
    const r = repo || config.githubDefaultRepo;
    if (!o || !r) return { ok: false, error: "Owner/repo wajib." };
    return safeOctokit((c) => c.rest.repos.delete({ owner: o, repo: r }));
  },

  async createRelease({ owner, repo, tagName, name = "", body = "", draft = true, prerelease = false } = {}) {
    const o = owner || config.githubDefaultOwner;
    const r = repo || config.githubDefaultRepo;
    if (!o || !r || !tagName) return { ok: false, error: "Field wajib: owner, repo, tagName." };
    return safeOctokit((c) =>
      c.rest.repos.createRelease({
        owner: o,
        repo: r,
        tag_name: tagName,
        name: name || tagName,
        body,
        draft: Boolean(draft),
        prerelease: Boolean(prerelease)
      })
    );
  },

  async updateSecret() {
    return {
      ok: false,
      error: "Update secret belum diimplementasikan. Jangan kirim secret ke chat; lakukan via GitHub UI/CLI lokal."
    };
  }
};
