import path from 'node:path'

/**
 * `cwd` and every parent up to the filesystem root, nearest first. Project-scope
 * config (.claude/skills, .mcp.json, ~/.claude.json project entries) is found the
 * way git finds .git — walking up — so opening a subfolder of a repo still
 * surfaces the repo root's config, matching what the engine loads for a run.
 */
export function ancestorDirs(cwd: string): string[] {
  const dirs: string[] = []
  let dir = path.resolve(cwd)
  for (;;) {
    dirs.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirs
}
