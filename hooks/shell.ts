// Reads a shell line the way a shell would, enough to tell which commands
// it runs. Pure, so the tests read it.

// The simple commands of a shell line, each as its words: quotes kept
// together, heredoc bodies dropped (they are data, not commands).
export function simpleCommands(line: string): string[][] {
  const text = line.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '')
  const commands: string[][] = []
  let words: string[] = []
  let word: string | undefined
  let quote: string | undefined
  const endWord = () => {
    if (word !== undefined) words.push(word)
    word = undefined
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else word = (word ?? '') + char
    } else if (char === "'" || char === '"') {
      quote = char
      word = word ?? ''
    } else if (char === '\\' && index + 1 < text.length) {
      index += 1
      if (text[index] !== '\n') word = (word ?? '') + text[index]
    } else if (/[;&|()\n]/.test(char)) {
      endCommand()
    } else if (/\s/.test(char)) {
      endWord()
    } else {
      word = (word ?? '') + char
    }
  }
  endCommand()
  return commands
}

// The command a wrapper runs: env assignments and `timeout 60`, `direnv exec .`,
// `devbox run --`, `nohup`, `sudo` and the like dropped.
export function unwrapped(command: readonly string[]): string[] {
  let words = [...command]
  for (;;) {
    const [first = '', second = ''] = words
    if (/^[A-Z_][A-Z0-9_]*=/.test(first) || ['exec', 'time', 'command', 'env', 'nohup', 'sudo'].includes(first)) words = words.slice(1)
    else if (first === 'timeout') words = words.slice(words.findIndex((one, index) => index > 0 && /^\d/.test(one)) + 1 || 1)
    else if (first === 'direnv' && second === 'exec') words = words.slice(3)
    else if (first === 'devbox' && second === 'run') words = words.slice(words[2] === '--' ? 3 : 2)
    else return words
  }
}

// git's options that take a value before the subcommand (`git -C dir push`).
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

// Whether the line runs something that starts new checks: a git push, a PR
// created, readied or merged, a run re-run.
export function startsChecks(line: string): boolean {
  return simpleCommands(line).some(command => {
    const words = unwrapped(command)
    const name = words[0]?.split('/').at(-1)
    const args = words.slice(1)
    if (name === 'git') {
      let index = 0
      while (index < args.length && args[index]!.startsWith('-')) index += GIT_VALUED.has(args[index]!) ? 2 : 1
      return args[index] === 'push'
    }
    if (name === 'gh') {
      const [group, action] = args.filter(one => !one.startsWith('-'))
      return (group === 'pr' && ['create', 'ready', 'merge'].includes(action ?? '')) || (group === 'run' && action === 'rerun')
    }
    return false
  })
}

// The branch a HEAD file names; undefined when detached.
export function branchOf(head: string): string | undefined {
  return /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head)?.[1]
}

// Where a `.git` file (a worktree's, a submodule's) says the git dir is.
export function gitDirOf(dotGit: string, directory: string): string | undefined {
  const target = /^gitdir:\s*(.+?)\s*$/m.exec(dotGit)?.[1]
  if (target === undefined) return undefined
  return target.startsWith('/') ? target : `${directory}/${target}`
}
