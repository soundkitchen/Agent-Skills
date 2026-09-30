# Agent-Skills

Claude Code 用の自作 skill を管理するリポジトリ。

## 構成

skill ごとにディレクトリを切り、その中に `SKILL.md` を置く。

```
Agent-Skills/
  <skill-name>/
    SKILL.md
```

`SKILL.md` は Claude が読む指示書なので英語で書く(トークン効率のため)。README やコミットメッセージなど人が読むものは日本語で書く。

## インストール(グローバル設定)

`~/.claude/skills/` にシンボリックリンクを張ると、全プロジェクトで使えるようになる。

```sh
ln -s "$PWD/<skill-name>" ~/.claude/skills/<skill-name>
```

## skill 一覧

| skill | 概要 | 使い方 |
|---|---|---|
| [you-are-a-reviewer](you-are-a-reviewer/SKILL.md) | セッションをレビュー担当にする。他セッションからの依頼を code-review でレビューし、結果を依頼元に返す。2 回目以降は前回の指摘に絞って確認する | `/you-are-a-reviewer medium --comment`(引数は code-review と同じ。ただし `ultra` と `--fix` は非対応) |
