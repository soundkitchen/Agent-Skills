# Agent-Skills

Claude Code 用の自作 skill と mod の集まり。

## skill 一覧

| skill | 概要 |
|---|---|
| [you-are-a-reviewer](you-are-a-reviewer/README.md) | セッションをレビュー担当にする。他のセッションから届いたレビュー依頼を code-review でレビューし、結果を返す。[request-review](request-review/README.md) と組で使う |
| [request-review](request-review/README.md) | you-are-a-reviewer のセッションに、今のブランチの PR のレビューを依頼する。LGTM が出るまで修正と再依頼を繰り返すこともできる |
| [wrap-up](wrap-up/README.md) | セッションを閉じる前に、やり残しを片付ける。機械的なものはその場で片付け、残りの作業は Issue・PR のコメント・docs などに引き継ぐ |

## mod 一覧

| mod | 概要 |
|---|---|
| [docs-sync](docs-sync/README.md) | PR を作る前に、実装とドキュメントの差異を確認する。Claude が `gh pr create` を実行する直前に割り込み、ずれがあれば止めて直させる |

mod は、Claude Code の動きそのものに割り込む拡張(JavaScript / TypeScript で書く plugin)。skill と違って呼び出す必要はなく、インストールしておけばすべてのセッションで常に動く。

使い方や前提は、各 skill・mod の README を参照。

## 前提

- [Claude Code](https://code.claude.com/docs/en/overview)
- mod を使うには、Claude Code v2.1.287 以降が要る
- skill・mod ごとの前提(外部ツールなど)は、それぞれの README に書いてある

## インストール

リポジトリを clone し、使いたい skill・mod のディレクトリを `~/.claude/skills/` にシンボリックリンクする。全プロジェクトで使えるようになる。

```sh
git clone https://github.com/soundkitchen/Agent-Skills.git
cd Agent-Skills
mkdir -p ~/.claude/skills
ln -s "$PWD/<name>" ~/.claude/skills/<name>
```

- mod も skill と同じ場所に置く。Claude Code は、`~/.claude/skills/` の中で `.claude-plugin/plugin.json` を持つディレクトリを plugin として読み込む(`~/.claude/plugins/` は marketplace からインストールした plugin の置き場で、手で置いたものは読み込まれない)
- シンボリックリンクにしておくと、`git pull` で skill・mod が更新される
- 特定のプロジェクトだけで使う場合は、そのプロジェクトの `.claude/skills/` にリンクまたはコピーする
- mod は、セッションの起動時に読み込まれる。起動中のセッションに反映するには `/reload-plugins` を実行する
- skill の内容は、呼び出したときにそのセッションへ読み込まれる。そのため、すでに skill を呼び出したセッションは、skill を更新しても古い内容のまま動く(とくに、待機し続けるレビュアーのセッション)。反映するには、そのセッションで skill を呼び出し直すか、セッションを起動し直す

## リポジトリの構成

```
Agent-Skills/
  README.md          ← このファイル(skill・mod の一覧・共通の前提・インストール)
  <skill-name>/
    SKILL.md         ← Claude が読む指示書
    README.md        ← 人向けの説明(使い方・引数・前提)
  <mod-name>/
    .claude-plugin/plugin.json  ← plugin のマニフェスト
    hooks/hooks.json            ← hooks module の場所(`modules`)
    hooks/register.ts           ← mod の本体(hooks module)
    tests/*.test.ts             ← `claude plugin test` で実行するテスト
    tsconfig.json               ← 型チェックの設定(Claude Code が書き出す型定義を参照する)
    README.md                   ← 人向けの説明
```

- `SKILL.md` は Claude が読む指示書なので英語で書く(トークン効率のため)。README やコミットメッセージなど人が読むものは日本語で書く
- mod のコードのうち、Claude が読む文字列(判定のプロンプト・ツール呼び出しを止める理由など)は英語で書く。ユーザーに見せる文字列(確認のダイアログなど)とコードコメントは日本語で書く
- 挙動の詳細は、skill は `SKILL.md`、mod は hooks module(`hooks/register.ts`)が正とする。README は使い方の説明にとどめ、細かい仕様はそれらへのリンクで済ませる
- skill・mod を追加・変更したら、その README と、このファイルの一覧も同じ PR で更新する
- mod を変更したら、`claude plugin validate` と `claude plugin test` が通ることを確かめる

## ライセンス

[MIT License](LICENSE)
