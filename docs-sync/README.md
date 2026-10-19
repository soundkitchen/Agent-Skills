# docs-sync

PR に入る前に、実装とドキュメントの差異を確認する mod。Claude が `gh pr create` を実行しようとするときと、開いている PR があるブランチへ `git push` しようとするときに、その直前に割り込む。ブランチの差分とドキュメントを別のモデル呼び出しで突き合わせ、ずれがあれば PR の作成や push を止める。止めるときは、どこがずれているかを Claude に伝えて直させる。

skill と違い、呼び出す必要はない。インストールしておけば、すべてのセッションで常に動く。

## 前提

- Claude Code v2.1.287 以降(mods が使えるバージョン)
- PR を作るリポジトリが git 管理で、PR を出す先のリポジトリを指す remote に base ブランチがあること(ふつうは `origin/main`、fork の構成なら `upstream/main` など)
- PR の作成と push を Claude に頼むこと。docs-sync が見るのは、Claude が Bash ツールで実行する `gh pr create` と `git push` だけ
- [GitHub CLI](https://cli.github.com/)(`gh`)がインストール・認証済みであること。PR を作った後の push を判定するとき(push 先のブランチに開いている PR があるかを確かめる)と、`gh pr create` のとき(PR を出す先のリポジトリと既定のブランチを確かめる)に使う。`gh` がないと、PR を作った後の push は判定せず、`gh pr create` では `origin` の base と比べる(fork の構成では、fork 側の古い base と比べることになる)

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

- **割り込むのは、実際に `gh pr create` を実行するときと、開いている PR があるブランチへ `git push` するときだけ。**
  - 対象は Claude の Bash ツールの呼び出し。コマンドを `&&` `;` `|` などで区切り、`gh pr create` か `git push` で始まる部分があるものだけを判定する(`git push && gh pr create ...` のような連結も含む)。先頭の環境変数の指定(`NAME=value`)や、`env` `command` `time` `nohup` `exec` の前置きは飛ばして見る
  - `$(...)` やバッククォートの中で実行される `gh pr create` や `git push` も対象(`PR_URL=$(gh pr create ...)` など)
  - 引用符・ヒアドキュメントの中の文字列には反応しない。コミットメッセージや PR へのコメントの本文に「gh pr create」と書いてあっても、判定しない。`--title` や `--body` の値も、`--base` / `--head` として読まない。リダイレクト(`> file`・`2>&1` など)も、引数として読まない
  - `gh pr create --help` も判定しない
  - `git push` は、push で更新される開いている PR があるときだけ判定する。開いている PR の一覧を `gh pr list --state open` で 1 回だけ取り、head のリポジトリとブランチが push 先と一致するものを探す。PR がないときや、PR があるかを確かめられないとき(`gh` が使えない、remote の URL からリポジトリを読み取れない、`cd "$DIR"` のように場所を読み取れない、など)は、判定せずにそのまま push する(PR を作るときに判定する)
    - push 先のリポジトリは、push 先の remote の URL から求める。remote の指定がなければ、git と同じく `branch.<名前>.pushRemote`・`remote.pushDefault`・upstream の remote・`origin` の順に決める。そのため、fork に push しても、元のリポジトリから出した PR は判定しない(fork から出した PR は判定する)
    - push 先のブランチは、refspec があればその push 先(`HEAD:fix/x` なら `fix/x`)。なければ今のブランチで、upstream の remote へ push するなら upstream のブランチ、ほかの remote なら同じ名前
    - `git -C <dir>` は `cd` と同じく扱う(`--work-tree` は作業ツリーを変えるだけなので、場所は変えない)。`--git-dir` は、`.git` を指すならその親へ移り、それ以外(bare リポジトリなど)は判定しない
    - ブランチの削除(`--delete` / `-d` / `:branch`)、dry run(`--dry-run` / `-n`)、`--all` / `--branches` / `--mirror`、`--prune`、ヘルプ(`--help` / `-h`)、refspec のない `--tags` は判定しない
    - `git push ... && gh pr create ...` のように同じコマンドに `gh pr create` があれば、`gh pr create` として 1 回だけ判定する。同じコマンドに push が複数あれば、すべてを順に判定する
  - 同じコマンドの中で、`gh pr create` や判定する `git push` より前に、読むだけでない git コマンド(`commit`・`add`・`checkout`・`branch` など、`status`・`log`・`diff`・`show`・`fetch` などの読むだけのもの以外)や `gh pr checkout` があるときは、判定せずに止め、分けて実行するよう Claude に伝える。`$(...)` の中にあるものも含む。docs-sync はコマンドを実行する前に判定するので、そのコマンドで作られる・動かされるコミットを見られないため。push 先のリモートとブランチを書いた push で、開いている PR がないもの(`git commit && git push -u origin <新しいブランチ>` など)は止めない。remote や refspec を省いた push と、`HEAD` へ push するものは、そのコマンドで今のブランチや設定が変わりうるので、PR の有無に関係なく止める(`git commit && git push` など)
  - ユーザーが自分のターミナルで実行したコマンドや、GitHub の画面・MCP ツールで作る PR は対象外
- **比べるのは、PR に入るコミット済みの内容。** `gh pr create` では作る PR の内容、`git push` では push した後の PR の内容
  - 場所:コマンドの中に `cd` があれば、移った先のリポジトリ(`$(...)` の中の `cd` はサブシェルで動くので、外側のコマンドには効かない)。Windows では、ドライブ文字付きのパス(`D:/...`、`D:\...`、`D:`)と、Git Bash・MSYS2 の形(`/d/...`)、Cygwin の形(`/cygdrive/d/...`)も絶対パスとして扱う
  - base ブランチ:`gh pr create` の `--base` / `-B` の指定があればそれを使い、なければ PR を出す先のリポジトリの既定ブランチ(`gh repo view` で確かめる。`-R` / `--repo` の指定があればそのリポジトリ。remote が 1 つで `-R` もなければ、問い合わせずにその remote の既定ブランチを使う)。`git push` では、開いている PR の base。どちらも、PR を出す先のリポジトリを指す remote の `<remote>/<base>` を優先する。fork の構成(`origin` が自分の fork、`upstream` が元のリポジトリ)なら `upstream/<base>` になり、fork 側の古い `origin/<base>` との差分にはならない。そのリポジトリを指す remote がない、または `gh` で確かめられないときは `origin` を使う。`<remote>/<base>` をまだ fetch していなければ `origin/<base>` を使う。`<remote>/<base>` は最後に fetch した時点のものなので、古ければ先に fetch する
  - head:`gh pr create` では、`--head` / `-H` の指定があればそのブランチ(push 済みの `origin/<指定>` を優先)。なければ `HEAD`。`git push` では、push するローカルのコミット
  - 実装:`git diff <base>...<head>`
  - ドキュメント:head 時点の、git 管理下の `*.md` / `*.mdx` すべて

  未コミットの修正は見ないので、直したらコミットしてからやり直す
- **判定するモデルは、作業中のセッションと同じもの。** 判定は会話の履歴を持たない別の呼び出しで行うので、実装した本人の思い込みは入らない。差分とドキュメントが大きすぎるときは、関係しそうなドキュメントを先にモデルに選ばせてから判定する
- **差分が大きすぎて 1 回で判定できないときは、分けて判定する。**
  - まず、ドキュメントとのずれに関係しないファイルを外す。lock ファイル(`package-lock.json`・`yarn.lock`・`Cargo.lock` など)、minify されたもの(`*.min.js`・`*.min.css`)、source map(`*.map`)、バイナリ、`.gitattributes` で `linguist-generated` か `linguist-vendored` を指定したもの
  - 残りをファイルごとに取り、パスの順に、1 回の判定に入るだけまとめる。判定するのは最大 5 回まで。各回には、ブランチ全体の変更されたファイルの一覧も渡す
  - 判定している間は、プロンプトの下に進み具合(`3/5` など)を出す
  - ずれが見つかっても、残りの部分も最後まで判定し、見つかったずれをまとめて伝える
  - 判定できないファイルが残ることがある。1 つで大きすぎるもの、5 回に入りきらないもの、モデルの呼び出しに失敗した回のものなど。ずれが見つかったときは、それらのファイルもあわせて伝えて止める。ずれがなければ、判定できなかったとして扱う(下の「判定できなかった」を参照)
- **判定の結果に応じて、次のように動く。**
  - ずれがない:そのまま PR を作る(push する)。リポジトリと base ごとに、最後に通ったコミットを記録し、同じコミットで PR を作り直したり push したりしても判定しない(`gh pr create` で通ったコミットをそのまま push しても判定しない)
  - 通したときは、`gh pr create` や `git push` の結果に添えて、docs-sync が確認したことと通した理由を Claude に伝える(ユーザーの画面には出ない)。理由は、判定してずれがなかった、同じコミットですでに通っていた、差分がなかった、ドキュメントに関係しないファイルしか変わっていなかった、ドキュメントがなかった、判定できなかったがユーザーが続けることを選んだ(同じコミットで以前に選んだ場合も含む)、のいずれか
  - ずれがある:PR の作成や push を止める。どのドキュメントの何がずれているかと、次の指示を Claude に伝える
    - ドキュメントを実装に合わせて直し、コミット・push してからもう一度 PR を作る(push を止めたときは、直したものをコミットしてから push し直す)
    - ドキュメントを仕様として扱うプロジェクトで、実装が仕様から外れている場合は、どちらを直すかをユーザーに確認する
    - 指摘が間違っていると思ったら、ユーザーに説明して確認する
  - 判定できなかった(モデルの呼び出しの失敗、分けても判定できないファイルが残った、ドキュメントが多すぎて判定に使うものを選べなかった、など):このまま PR を作るか(push するか)をユーザーに聞く。差分の一部だけを判定できなかったときは、そのファイルを示す
    - 続けることを選んだら、そのコミットを記録し、同じコミットで PR を作り直したり push したりしても、もう判定も質問もしない
    - 中止を選んだとき、または誰も答えられない場合(`claude -p` など)は止める。止めるときは、ずれが見つかったのではなく判定できなかったことと、取れる手段を Claude に伝える。手段は理由に応じて、もう一度実行する、base ブランチを fetch する、PR を小さく分ける、docs-sync を一時的に止める(`claude plugin disable docs-sync@skills-dir`)、確認なしで進めたいならユーザーが自分のターミナルで実行する、など
- **ブランチに差分がない、またはドキュメントが 1 つもない場合は、** 判定せずにそのまま通す(通したことは Claude に伝える)

挙動の詳細は [hooks/register.ts](hooks/register.ts) を参照。

## 注意

- 判定は LLM なので、誤った指摘をすることがある。指摘が間違っていると思ったら、Claude がユーザーに確認する
- 判定のたびに、作業中のセッションと同じモデルを 1 回(ドキュメントが多いときは 2 回)呼ぶ。差分を分けて判定するときは、さらに分けた数だけ(最大 5 回)呼ぶ。PR を作った後は、新しいコミットを push するたびに判定する。そのぶん、プランや API キーの使用量を使う
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
