# Agent-Skills

Claude Code 用の自作 skill を管理するリポジトリ。

## 構成

skill ごとにディレクトリを切り、その中に `SKILL.md` を置く。

```
Agent-Skills/
  <skill-name>/
    SKILL.md
```

## インストール(グローバル設定)

`~/.claude/skills/` にシンボリックリンクを張ると、全プロジェクトで使えるようになる。

```sh
ln -s "$PWD/<skill-name>" ~/.claude/skills/<skill-name>
```

## skill 一覧

(まだない)
