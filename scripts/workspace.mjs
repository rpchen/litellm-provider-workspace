#!/usr/bin/env node
// 跨仓库工作区工具：clone 缺失仓库 / 查看状态 / 在各仓库执行命令 / 运行各仓库 CI 等价校验。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { repos } = JSON.parse(readFileSync(join(root, 'workspace.json'), 'utf8'))
const win = process.platform === 'win32'

const quote = (a) => (/[\s"]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a)

// Windows 上 npm/bun/openspec 是 .cmd，需要经 shell 启动；此时把命令拼成单个字符串。
function run(cwd, cmd, args, { capture = false } = {}) {
  const options = { cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' }
  const r = win
    ? spawnSync([cmd, ...args].map(quote).join(' '), { ...options, shell: true })
    : spawnSync(cmd, args, options)
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() }
}

const dirOf = (repo) => join(root, repo.name)

function select(names) {
  if (names.length === 0) return repos
  const picked = repos.filter((r) => names.includes(r.name))
  const unknown = names.filter((n) => !repos.some((r) => r.name === n))
  if (unknown.length) fail(`未知仓库: ${unknown.join(', ')}`)
  return picked
}

function fail(msg) {
  console.error(msg)
  process.exit(1)
}

function requireCloned(repo) {
  if (!existsSync(join(dirOf(repo), '.git'))) fail(`${repo.name} 尚未 clone，先运行 clone 命令`)
}

const commands = {
  clone() {
    for (const repo of repos) {
      if (existsSync(join(dirOf(repo), '.git'))) {
        console.log(`= ${repo.name}: 已存在，跳过`)
        continue
      }
      console.log(`+ ${repo.name}: clone ${repo.url}`)
      if (!run(root, 'git', ['clone', '--branch', repo.branch, repo.url, repo.name]).ok) fail('clone 失败')
    }
  },

  status() {
    for (const repo of repos) {
      if (!existsSync(join(dirOf(repo), '.git'))) {
        console.log(`${repo.name.padEnd(28)} (未 clone)`)
        continue
      }
      const git = (...a) => run(dirOf(repo), 'git', a, { capture: true }).out
      const branch = git('branch', '--show-current') || '(detached)'
      const sha = git('rev-parse', '--short', 'HEAD')
      const dirty = git('status', '--short').split('\n').filter(Boolean).length
      const ahead = git('rev-list', '--left-right', '--count', `origin/${repo.branch}...HEAD`).split(/\s+/)
      const sync = ahead.length === 2 ? `落后 ${ahead[0]} / 领先 ${ahead[1]}` : '无法比较 origin'
      console.log(`${repo.name.padEnd(28)} ${branch.padEnd(24)} ${sha}  未提交 ${dirty}  ${sync}`)
    }
  },

  fetch() {
    for (const repo of repos) {
      requireCloned(repo)
      console.log(`> ${repo.name}: git fetch --prune`)
      run(dirOf(repo), 'git', ['fetch', '--prune'])
    }
  },

  install(names) {
    for (const repo of select(names)) {
      requireCloned(repo)
      console.log(`> ${repo.name}: ${repo.install.join(' ')}`)
      if (!run(dirOf(repo), repo.install[0], repo.install.slice(1)).ok) fail(`${repo.name} 安装失败`)
    }
  },

  // node scripts/workspace.mjs exec [仓库名...] -- <命令 ...>
  exec(args) {
    const sep = args.indexOf('--')
    if (sep < 0 || sep === args.length - 1) fail('用法: exec [仓库名...] -- <命令 ...>')
    const cmd = args.slice(sep + 1)
    for (const repo of select(args.slice(0, sep))) {
      requireCloned(repo)
      console.log(`> ${repo.name}: ${cmd.join(' ')}`)
      if (!run(dirOf(repo), cmd[0], cmd.slice(1)).ok) fail(`${repo.name} 命令失败`)
    }
  },

  // 按各仓库 AGENTS.md 约定的提交前校验顺序执行；任一失败即停。
  verify(names) {
    for (const repo of select(names)) {
      requireCloned(repo)
      for (const step of repo.verify) {
        console.log(`> ${repo.name}: ${step.join(' ')}`)
        if (!run(dirOf(repo), step[0], step.slice(1)).ok) fail(`${repo.name} 校验失败: ${step.join(' ')}`)
      }
    }
    console.log('校验全部通过')
  },
}

const [name, ...rest] = process.argv.slice(2)
if (!commands[name]) {
  fail('用法: node scripts/workspace.mjs <clone|status|fetch|install|verify|exec> [仓库名...]')
}
commands[name](rest)
