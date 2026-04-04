// ===========================================================================
// AI Blog Auto-Pipeline — Google Apps Script
//
// GAS のタイムドリブントリガーで週3回 Deep Research を実行し、
// 結果を Gemini Flash でブログ記事に変換して GitHub に直接コミットする。
// ===========================================================================

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  return {
    geminiApiKey: props.getProperty('GEMINI_API_KEY'),
    githubToken: props.getProperty('GITHUB_TOKEN'),
    githubOwner: props.getProperty('GITHUB_OWNER'),
    githubRepo: props.getProperty('GITHUB_REPO'),
    githubBranch: props.getProperty('GITHUB_BRANCH') || 'main',
  };
}

const INTERACTIONS_BASE =
  'https://generativelanguage.googleapis.com/v1beta/interactions';
const GENERATE_CONTENT_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

/** Astro 用 Markdown 生成ルール（formatBlogPost_ のプロンプト本文） */
const BLOG_MARKDOWN_RULES_ =
  'ルール:\n' +
  '- 日本語で執筆。技術的に正確で読みやすい文体。段落はおおむね3〜5文を目安にする。\n' +
  '- 見出し: 本文に #（h1相当）を書かない。記事タイトルは frontmatter の title のみ。最初の章は ## から。### は ## の直下のみ。#### まで使う場合は階層を飛ばさない。\n' +
  '- 許可する Markdown: 段落、##〜####、箇条書き・番号リスト、引用、コードフェンス（言語識別子必須。例 ```ts）、水平線、リンク、表、画像（alt 必須）。\n' +
  '- 禁止: 生HTML（div/span/script/style 等）、インラインHTML、見出し代わりの単独太字行のみの行。\n' +
  '- 出典URLは記事末尾に「## 参考リンク」セクションを付け、[タイトル](URL) 形式の箇条書きで列挙する。\n' +
  '- frontmatter の先頭 --- から終端 --- まで以外に説明文を付けない。\n';

// ---------------------------------------------------------------------------
// 1. startResearch — タイマートリガーから呼ばれるエントリポイント
// ---------------------------------------------------------------------------

function startResearch() {
  const cfg = getConfig_();

  // Topic 選定
  const topic = selectTopic_(cfg);
  Logger.log('Selected topic: ' + topic);

  // Deep Research 開始 (background=true)
  const res = UrlFetchApp.fetch(INTERACTIONS_BASE + '?key=' + cfg.geminiApiKey, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify({
      agent: 'deep-research-pro-preview-12-2025',
      input: topic,
      background: true,
    }),
  });

  if (res.getResponseCode() !== 200) {
    Logger.log('Deep Research start failed: ' + res.getContentText());
    return;
  }

  const interaction = JSON.parse(res.getContentText());
  Logger.log('Deep Research started — interaction_id: ' + interaction.id);

  // State を保存
  const props = PropertiesService.getScriptProperties();
  props.setProperty('CURRENT_INTERACTION_ID', interaction.id);
  props.setProperty('CURRENT_TOPIC', topic);
  props.setProperty('POLL_START_TIME', String(Date.now()));

  // 5 分おきポーリングトリガーを設定
  ScriptApp.newTrigger('pollResearch')
    .timeBased()
    .everyMinutes(5)
    .create();
}

// ---------------------------------------------------------------------------
// 2. pollResearch — 5 分おきに実行、完了検知で後続処理
// ---------------------------------------------------------------------------

function pollResearch() {
  const cfg = getConfig_();
  const props = PropertiesService.getScriptProperties();
  const interactionId = props.getProperty('CURRENT_INTERACTION_ID');

  if (!interactionId) {
    deletePollingTrigger_();
    return;
  }

  // タイムアウト判定 (70 分)
  const elapsed = Date.now() - Number(props.getProperty('POLL_START_TIME'));
  if (elapsed > 70 * 60 * 1000) {
    Logger.log('Deep Research timed out after 70 minutes');
    cleanup_();
    return;
  }

  // ステータス確認
  const res = UrlFetchApp.fetch(
    INTERACTIONS_BASE + '/' + interactionId + '?key=' + cfg.geminiApiKey,
    { muteHttpExceptions: true },
  );

  if (res.getResponseCode() !== 200) {
    Logger.log('Poll request failed: ' + res.getContentText());
    return;
  }

  const interaction = JSON.parse(res.getContentText());
  Logger.log('Poll status: ' + interaction.status);

  if (interaction.status === 'completed') {
    const researchResult =
      interaction.outputs[interaction.outputs.length - 1].text;
    Logger.log(
      'Research completed — result length: ' + researchResult.length,
    );

    // ブログ記事生成
    const blogPost = formatBlogPost_(cfg, researchResult);
    Logger.log('Blog post generated — length: ' + blogPost.length);

    // GitHub にコミット
    commitToGitHub_(cfg, blogPost);
    Logger.log('Committed to GitHub');

    cleanup_();
  } else if (interaction.status === 'failed') {
    Logger.log(
      'Deep Research failed: ' + JSON.stringify(interaction.error || ''),
    );
    cleanup_();
  }
  // in_progress → 次の 5 分トリガーで再確認
}

// ---------------------------------------------------------------------------
// 3. selectTopic_ — Gemini Flash でトピックを選定
// ---------------------------------------------------------------------------

function selectTopic_(cfg) {
  const today = Utilities.formatDate(
    new Date(),
    'Asia/Tokyo',
    'yyyy年M月d日',
  );

  const res = UrlFetchApp.fetch(
    GENERATE_CONTENT_BASE + '?key=' + cfg.geminiApiKey,
    {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text:
                  '今日は' +
                  today +
                  'です。AI分野（LLM、生成AI、機械学習、ロボティクス等）で' +
                  '今最も注目すべきトピックを1つ選び、' +
                  'Deep Researchエージェントへの具体的な調査指示を日本語で作成してください。\n\n' +
                  'ルール:\n' +
                  '- 直近1〜2週間のニュース、論文、製品リリースを考慮\n' +
                  '- 調査指示のみを出力（前置き不要）\n' +
                  '- 調査の範囲、深さ、着目ポイントを明示',
              },
            ],
          },
        ],
      }),
    },
  );

  const data = JSON.parse(res.getContentText());
  return data.candidates[0].content.parts[0].text;
}

// ---------------------------------------------------------------------------
// 4. formatBlogPost_ — 調査結果を Astro Markdown に変換
// ---------------------------------------------------------------------------

function formatBlogPost_(cfg, researchResult) {
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

  const res = UrlFetchApp.fetch(
    GENERATE_CONTENT_BASE + '?key=' + cfg.geminiApiKey,
    {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text:
                  '以下の調査結果をブログ記事に変換してください。\n\n' +
                  '出力フォーマット（これを厳密に守ること）:\n' +
                  '---\n' +
                  'title: "記事タイトル"\n' +
                  'description: "記事の概要（1-2文）"\n' +
                  'pubDate: "' + today + '"\n' +
                  'category: ml\n' +
                  'articleKind: weekly-brief\n' +
                  'tags: ["タグ1", "タグ2", "タグ3"]\n' +
                  '---\n\n' +
                  'category は次のいずれかのキーのみ（引用なし）: ml | language | tooling | curation。Deep Research 週次記事は ml。\n' +
                  'articleKind は次のいずれかのみ（引用なし）: weekly-brief | spotlight。タイマー定例は weekly-brief。\n' +
                  'tags は英語スラッグ推奨（例 llm, gemini）。\n\n' +
                  '（ここに本文を Markdown で記述）\n\n' +
                  BLOG_MARKDOWN_RULES_ +
                  '\n' +
                  '調査結果:\n' +
                  researchResult,
              },
            ],
          },
        ],
      }),
    },
  );

  const data = JSON.parse(res.getContentText());
  let content = data.candidates[0].content.parts[0].text;

  // Gemini が ```markdown ... ``` で囲む場合があるので除去
  content = content.replace(/^```markdown\s*\n?/, '').replace(/\n?```\s*$/, '');

  return content;
}

// ---------------------------------------------------------------------------
// 5. commitToGitHub_ — GitHub Contents API でファイルを作成
// ---------------------------------------------------------------------------

function commitToGitHub_(cfg, markdownContent) {
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const slug = today;
  const path = 'src/content/blog/' + slug + '.md';

  const url =
    'https://api.github.com/repos/' +
    cfg.githubOwner +
    '/' +
    cfg.githubRepo +
    '/contents/' +
    path;

  // 同名ファイルが既にある場合は sha を取得（上書き用）
  var sha = null;
  var existing = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      Authorization: 'token ' + cfg.githubToken,
      Accept: 'application/vnd.github.v3+json',
    },
    muteHttpExceptions: true,
  });
  if (existing.getResponseCode() === 200) {
    sha = JSON.parse(existing.getContentText()).sha;
  }

  var payload = {
    message: 'Add blog post: ' + today,
    content: Utilities.base64Encode(markdownContent, Utilities.Charset.UTF_8),
    branch: cfg.githubBranch,
  };
  if (sha) {
    payload.sha = sha;
  }

  UrlFetchApp.fetch(url, {
    method: 'put',
    headers: {
      Authorization: 'token ' + cfg.githubToken,
      Accept: 'application/vnd.github.v3+json',
    },
    contentType: 'application/json',
    payload: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deletePollingTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'pollResearch') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function cleanup_() {
  deletePollingTrigger_();
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('CURRENT_INTERACTION_ID');
  props.deleteProperty('CURRENT_TOPIC');
  props.deleteProperty('POLL_START_TIME');
}

// ---------------------------------------------------------------------------
// Manual test helpers
// ---------------------------------------------------------------------------

function testStartResearch() {
  startResearch();
}

function testPollResearch() {
  pollResearch();
}
