# docs-sync

PR を作る前に、実装とドキュメントの差異を確認する mod。Claude が `gh pr create` を実行しようとすると、その直前に割り込む。ブランチの差分とドキュメントを別のモデル呼び出しで突き合わせ、ずれがあれば PR の作成を止める。止めるときは、どこがずれているかを Claude に伝えて直させる。

skill と違い、呼び出す必要はない。インストールしておけば、すべてのセッションで常に動く。

## 前提

- Claude Code v2.1.287 以降(mods が使えるバージョン)
- PR を作るリポジトリが git 管理で、`origin` に base ブランチがあること(`origin/main` など)
- PR の作成を Claude に頼むこと。docs-sync が見るのは、Claude が Bash ツールで実行する `gh pr create` だけ

## インストール

ほかの skill と同じく、ディレクトリを `~/.claude/skills/` にシンボリックリンクする(手順は [root の README](../README.md#インストール) を参照)。

```sh
ln -s "$PWD/docs-sync" ~/.claude/skills/docs-sync
```

`.claude-plugin/plugin.json` を持つディレクトリなので、Claude Code は `~/.claude/skills/` に置かれたこれを plugin(`docs-sync@skills-dir`)として読み込む。marketplace からのインストールや、承認の操作は要らない。

- 読み込まれたかは、`claude plugin list` の「Skills-directory plugins」に `docs-sync@skills-dir` が出るかで確かめられる
- 起動中のセッションに反映するには、`/reload-plugins` を実行するか、セッションを起動し直す
- 一時的に止めるには `claude plugin disable docs-sync@skills-dir` を実行する。やめるときはシンボリックリンクを削除する

## 主な挙動

- **割り込むのは、実際に `gh pr create` を実行するときだけ。**
  - 対象は Claude の Bash ツールの呼び出し。コマンドを `&&` `;` `|` などで区切り、`gh pr create` で始まる部分があるものだけを判定する(`git push && gh pr create ...` のような連結も含む)。先頭の環境変数の指定(`NAME=value`)や、`env` `command` `time` `nohup` `exec` の前置きは飛ばして見る
  - `$(...)` やバッククォートの中で実行される `gh pr create` も対象(`PR_URL=$(gh pr create ...)` など)
  - 引用符・ヒアドキュメントの中の文字列には反応しない。コミットメッセージや PR へのコメントの本文に「gh pr create」と書いてあっても、判定しない。`--title` や `--body` の値も、`--base` / `--head` として読まない
  - `gh pr create --help` も判定しない
  - ユーザーが自分のターミナルで実行したコマンドや、GitHub の画面・MCP ツールで作る PR は対象外
- **比べるのは、PR に入るコミット済みの内容。**
  - 場所:コマンドの中に `cd` があれば、移った先のリポジトリ(`$(...)` の中の `cd` はサブシェルで動くので、外側の `gh pr create` には効かない)
  - base ブランチ:`gh pr create` の `--base` / `-B` の指定があればそれを使う(`origin/<指定>` を優先)。なければ `origin` の既定ブランチ
  - head:`--head` / `-H` の指定があればそのブランチ(push 済みの `origin/<指定>` を優先)。なければ `HEAD`
  - 実装:`git diff <base>...<head>`
  - ドキュメント:head 時点の、git 管理下の `*.md` / `*.mdx` すべて

  未コミットの修正は見ないので、直したらコミットしてからやり直す
- **判定するモデルは、作業中のセッションと同じもの。** 判定は会話の履歴を持たない別の呼び出しで行うので、実装した本人の思い込みは入らない。差分とドキュメントが大きすぎるときは、関係しそうなドキュメントを先にモデルに選ばせてから判定する
- **判定の結果に応じて、次のように動く。**
  - ずれがない:そのまま PR を作る。リポジトリと base ごとに、最後に通ったコミットを記録し、同じコミットで作り直しても判定しない
  - ずれがある:PR の作成を止める。どのドキュメントの何がずれているかと、次の指示を Claude に伝える
    - ドキュメントを実装に合わせて直し、コミット・push してからもう一度 PR を作る
    - ドキュメントを仕様として扱うプロジェクトで、実装が仕様から外れている場合は、どちらを直すかをユーザーに確認する
    - 指摘が間違っていると思ったら、ユーザーに説明して確認する
  - 判定できなかった(モデルの呼び出しの失敗、差分が大きすぎる、ドキュメントが多すぎて判定に使うものを選べなかった、など):このまま PR を作るかをユーザーに聞く。誰も答えられない場合(`claude -p` など)は止める
- **ブランチに差分がない、またはドキュメントが 1 つもない場合は、** 判定せずにそのまま通す

挙動の詳細は [hooks/register.ts](hooks/register.ts) を参照。

## 注意

- 判定は LLM なので、誤った指摘をすることがある。指摘が間違っていると思ったら、Claude がユーザーに確認する
- 判定のたびに、作業中のセッションと同じモデルを 1 回(ドキュメントが多いときは 2 回)呼ぶ。そのぶん、プランや API キーの使用量を使う
- インストールしてあるかぎり、どのプロジェクトでも動く。止めたいプロジェクトでは、`.claude/settings.local.json` の `enabledPlugins` に `"docs-sync@skills-dir": false` を書く

## 開発

```sh
claude plugin validate ./docs-sync   # マニフェストと hooks module の静的チェック
claude plugin test ./docs-sync       # tests/ のテストを実行
claude --plugin-dir ./docs-sync      # このセッションだけ読み込む。保存すると再読み込みされる
npx -p typescript tsc -p ./docs-sync # 型チェック
```

型チェックに使う型定義(`.claude-plugin/types/`)は、`--plugin-dir` で読み込んだときに Claude Code が書き出す(git 管理外)。一度読み込んでから `tsc` を実行する。

`~/.claude/skills/` にリンクした状態のまま `--plugin-dir` でも読み込むと、`--plugin-dir` のほうが優先される。
