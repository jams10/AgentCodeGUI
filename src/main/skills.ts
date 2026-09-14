import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { APP_HOME } from './engine/versions'
import { ancestorDirs } from './paths'
import type { SkillInfo, SkillScope } from '@shared/protocol'

// Skills the user has turned off in the app. We keep this list in the app's own
// home folder — NOT in the user's ~/.claude — so toggling a skill never rewrites
// Claude Code's own config. The choice is applied per-run via the SDK's
// `skillOverrides` flag layer (see disabledSkillOverrides), so a turned-off skill
// is simply hidden from the model for that run.
const DISABLED_PATH = path.join(APP_HOME, 'skills.json')

// global ("전역") skills: personal skills shared across every project
const GLOBAL_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills')

/**
 * Names the user has disabled. Stored (and applied) by name, because the engine's
 * `skillOverrides` is keyed by name — so disabling a name turns it off in every
 * scope, matching how the SDK treats skill names as global identifiers.
 */
function readDisabled(): Set<string> {
  try {
    const j = JSON.parse(fs.readFileSync(DISABLED_PATH, 'utf8'))
    const list: unknown = j?.disabled
    return new Set(Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeDisabled(set: Set<string>): void {
  fs.mkdirSync(APP_HOME, { recursive: true })
  fs.writeFileSync(DISABLED_PATH, JSON.stringify({ disabled: [...set].sort() }, null, 2))
}

// Minimal YAML-frontmatter reader. A SKILL.md opens with a `---` fence block of
// simple `key: value` lines; we only need `name` and `description`, so a full
// YAML parser would be overkill (and an extra dependency).
function parseFrontmatter(text: string): { name?: string; description?: string } {
  const body = text.replace(/^﻿/, '') // strip a leading BOM if present
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body)
  if (!m) return {}
  const out: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    let v = kv[2].trim()
    // unwrap a single layer of surrounding quotes, if any
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (!(kv[1] in out)) out[kv[1]] = v // first occurrence wins
  }
  return { name: out.name, description: out.description }
}

/** Read one scope's directory: each subfolder containing a SKILL.md is a skill. */
function discover(dir: string, scope: SkillScope, disabled: Set<string>): SkillInfo[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return [] // the skills dir doesn't exist for this scope → no skills
  }
  const skills: SkillInfo[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const file = path.join(dir, e.name, 'SKILL.md')
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      continue // a subfolder without a SKILL.md isn't a skill
    }
    const fm = parseFrontmatter(raw)
    const name = fm.name?.trim() || e.name // frontmatter name, else the folder name
    skills.push({
      name,
      description: fm.description?.trim() || '',
      scope,
      path: file,
      enabled: !disabled.has(name)
    })
  }
  return skills
}

/**
 * local ("로컬") skills: live in the project being worked on. Like git finding .git,
 * `.claude/skills` is searched in cwd and every parent (the engine reads ancestor
 * dirs too), so opening a subfolder of a repo still surfaces the repo's skills.
 * The nearest dir wins when two levels share a skill name; ~/.claude/skills is
 * skipped because it's already listed as the global scope.
 */
function discoverLocal(cwd: string, disabled: Set<string>): SkillInfo[] {
  const norm = (s: string): string => s.replace(/[\\/]+/g, '/').toLowerCase()
  const globalKey = norm(GLOBAL_SKILLS_DIR)
  const seen = new Set<string>()
  const local: SkillInfo[] = []
  for (const dir of ancestorDirs(cwd)) {
    const skillsDir = path.join(dir, '.claude', 'skills')
    if (norm(skillsDir) === globalKey) continue
    for (const s of discover(skillsDir, 'local', disabled)) {
      if (seen.has(s.name)) continue
      seen.add(s.name)
      local.push(s)
    }
  }
  return local
}

/** Every skill visible to a run from `cwd`: global (~/.claude) + project (.claude). */
export function listSkills(cwd: string): SkillInfo[] {
  const disabled = readDisabled()
  const global = discover(GLOBAL_SKILLS_DIR, 'global', disabled)
  const local = cwd && cwd.trim() ? discoverLocal(cwd, disabled) : []
  // alphabetical by name; global before local when two scopes share a name
  return [...global, ...local].sort(
    (a, b) => a.name.localeCompare(b.name) || (a.scope === b.scope ? 0 : a.scope === 'global' ? -1 : 1)
  )
}

/** Turn a skill on/off by name. Persisted to the app home folder. */
export function setSkillEnabled(name: string, enabled: boolean): void {
  const set = readDisabled()
  if (enabled) set.delete(name)
  else set.add(name)
  writeDisabled(set)
}

/**
 * The disabled skills as an SDK `skillOverrides` map ({ name: 'off', … }), or null
 * when nothing is disabled. Fed into a run's inline `settings` (the highest-priority
 * flag layer), so a turned-off skill is hidden from the model for that run without
 * ever editing the user's ~/.claude config.
 */
export function disabledSkillOverrides(): Record<string, 'off'> | null {
  const set = readDisabled()
  if (set.size === 0) return null
  const out: Record<string, 'off'> = {}
  for (const name of set) out[name] = 'off'
  return out
}
