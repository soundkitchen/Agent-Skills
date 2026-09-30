# Agent-Skills

Claude Code 用の自作 skill 集。

## skill 一覧

| skill | 概要 |
|---|---|
| [you-are-a-reviewer](you-are-a-reviewer/README.md) | セッションをレビュー担当にする。他のセッションから届いたレビュー依頼を code-review でレビューし、結果を返す。[request-review](request-review/README.md) と組で使う |
| [request-review](request-review/README.md) | you-are-a-reviewer のセッションに、今のブランチの PR のレビューを依頼する。LGTM が出るまで修正と再依頼を繰り返すこともできる |

使い方や前提は、各 skill の README を参照。

## 前提

- [Claude Code](https://code.claude.com/docs/en/overview)
- skill ごとの前提(外部ツールなど)は、各 skill の README に書いてある

## インストール

リポジトリを clone し、使いたい skill のディレクトリを `~/.claude/skills/` にシンボリックリンクする。全プロジェクトで使えるようになる。

```sh
git clone https://github.com/soundkitchen/Agent-Skills.git
cd Agent-Skills
mkdir -p ~/.claude/skills
ln -s "$PWD/<skill-name>" ~/.claude/skills/<skill-name>
```

- シンボリックリンクにしておくと、`git pull` で skill が更新される
- 特定のプロジェクトだけで使う場合は、そのプロジェクトの `.claude/skills/` にリンクまたはコピーする
- skill の内容は、呼び出したときにそのセッションへ読み込まれる。そのため、すでに skill を呼び出したセッションは、skill を更新しても古い内容のまま動く(とくに、待機し続けるレビュアーのセッション)。反映するには、そのセッションで skill を呼び出し直すか、セッションを起動し直す

## リポジトリの構成

```
Agent-Skills/
  README.md          ← このファイル(skill 一覧・共通の前提・インストール)
  <skill-name>/
    SKILL.md         ← Claude が読む指示書
    README.md        ← 人向けの説明(使い方・引数・前提)
```

- `SKILL.md` は Claude が読む指示書なので英語で書く(トークン効率のため)。README やコミットメッセージなど人が読むものは日本語で書く
- 挙動の詳細は `SKILL.md` が正とする。README は使い方の説明にとどめ、細かい仕様は `SKILL.md` へのリンクで済ませる
- skill を追加・変更したら、その skill の README と、このファイルの skill 一覧も同じ PR で更新する

## ライセンス

[MIT License](LICENSE)
