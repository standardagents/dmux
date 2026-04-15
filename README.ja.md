<p align="center">
  <img src="./dmux.png" alt="dmux logo" width="400" />
</p>

<h3 align="center">tmuxとworktreeを使った並列エージェント</h3>

<p align="center">
  分離されたgit worktreeで複数のAIコーディングエージェントを管理。<br/>
  ブランチ作成、開発、マージを &mdash; すべて並列で実行。
</p>

<p align="center">
  <a href="https://dmux.ai"><strong>ドキュメント</strong></a> &nbsp;&middot;&nbsp;
  <a href="https://dmux.ai#getting-started"><strong>クイックスタート</strong></a> &nbsp;&middot;&nbsp;
  <a href="https://github.com/formkit/dmux/issues"><strong>イシュー</strong></a>
</p>

<p align="center">
  <strong>言語:</strong>
  <a href="./README.md">English</a> |
  <a href="./README.ja.md">日本語</a>
</p>

---

<img src="./dmux.webp" alt="dmux demo" width="100%" />

## インストール

```bash
npm install -g dmux
```

## クイックスタート

```bash
cd /path/to/your/project
dmux
```

`n`キーを押して新しいペインを作成し、プロンプトを入力、1つ以上のエージェントを選択（またはプレーンターミナルの場合は選択なし）すると、dmuxが残りの処理（worktree、ブランチ、エージェント起動）を自動的に処理します。

## dmuxとは

dmuxは各タスクに対してtmuxペインを作成します。各ペインには独自のgit worktreeとブランチが割り当てられるため、エージェントは完全に分離されて作業できます。タスクが完了したら、ペインメニューで`m`を押してマージを選択すると、メインブランチに変更を取り込めます。

- **Worktree分離** &mdash; 各ペインは完全な作業コピーで、エージェント間の競合はありません
- **エージェントサポート** &mdash; Claude Code、Codex、OpenCode、Cline CLI、Gemini CLI、Qwen CLI、Amp CLI、pi CLI、Cursor CLI、Copilot CLI、Crush CLI
- **複数選択起動** &mdash; プロンプトごとに有効なエージェントを任意の組み合わせで選択可能
- **AI命名** &mdash; ブランチとコミットメッセージを自動生成
- **スマートマージ** &mdash; 自動コミット、マージ、クリーンアップを1ステップで実行
- **macOS通知** &mdash; バックグラウンドペインが処理完了時にネイティブのアラートを送信
- **内蔵ファイルブラウザ** &mdash; dmuxを離れずにペインのworktreeを閲覧、ファイル検索、コードや差分のプレビュー
- **ペイン表示制御** &mdash; 個別ペインの非表示、プロジェクトの分離、後から全表示の復元
- **マルチプロジェクト** &mdash; 同じセッションに複数のリポジトリを追加
- **ライフサイクルフック** &mdash; worktree作成、プレマージ、ポストマージ時のスクリプト実行

## キーボードショートカット

| キー | アクション |
|-----|--------|
| `n` | 新しいペイン（worktree + エージェント） |
| `t` | 新しいターミナルペイン |
| `j` / `Enter` | ペインにジャンプ |
| `m` | ペインメニューを開く |
| `f` | 選択したペインのworktreeを閲覧 |
| `x` | ペインを閉じる |
| `h` | 選択したペインを表示/非表示 |
| `H` | 他のすべてのペインを表示/非表示 |
| `p` | 別のプロジェクトに新しいペインを作成 |
| `P` | 選択したプロジェクトのペインのみ表示、その後すべて表示 |
| `s` | 設定 |
| `q` | 終了 |

## 必要要件

- tmux 3.0+
- Node.js 18+
- Git 2.20+
- 少なくとも1つのサポート対象エージェントCLI（例：[Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Codex](https://github.com/openai/codex)、[OpenCode](https://github.com/opencode-ai/opencode)、[Cline CLI](https://docs.cline.bot/cline-cli/getting-started)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)、[Qwen CLI](https://github.com/QwenLM/qwen-code)、[Amp CLI](https://ampcode.com/manual)、[pi CLI](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)、[Cursor CLI](https://docs.cursor.com/en/cli/overview)、[Copilot CLI](https://github.com/github/copilot-cli)、[Crush CLI](https://github.com/charmbracelet/crush)）
- [OpenRouter APIキー](https://openrouter.ai/)（オプション、AIブランチ名とコミットメッセージ用）

## ドキュメント

完全なドキュメントは **[dmux.ai](https://dmux.ai)** でご覧いただけます。セットアップガイド、設定、フックの情報が含まれています。

## コントリビュート

推奨されるローカル「dmux-on-dmux」開発ループ、フックセットアップ、PRワークフローについては、**[CONTRIBUTING.md](./CONTRIBUTING.md)** をご覧ください。

## ライセンス

MIT
