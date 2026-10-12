# ci-watch

Claude Code mod that watches the GitHub checks of the current branch's PR (or its workflow runs when there is no PR).

`/ci` opens a pane with every check and its link; the status line shows running checks; a notification tells when CI passes or fails. **Ask Claude to fix** puts the failed checks in the prompt.

Requires an authenticated [`gh`](https://cli.github.com).

## Install

In Claude Code:

```
/plugin install ci-watch --marketplace colorfield/claude-ci-watch
```
