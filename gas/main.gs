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
  'Markdown生成ルール:\n' +
  '- 日本語で執筆。技術的に正確で読みやすい文体。段落はおおむね3〜5文を目安にする。\n' +
  '- 見出し: 本文に #（h1相当）を書かない。最初の章は ## から。### は ## の直下のみ。#### まで使う場合は階層を飛ばさない。\n' +
  '- 許可する Markdown: 段落、##〜####、箇条書き・番号リスト、引用、コードフェンス（言語識別子必須。例 ```ts）、水平線、リンク、表、画像（alt 必須）。\n' +
  '- 禁止: 生HTML（div/span/script/style 等）、インラインHTML、見出し代わりの単独太字行のみの行、およびフロントマター（---）の出力。\n' +
  '- 出典URLは記事末尾に「## 参考リンク」セクションを付け、[タイトル](URL) 形式の箇条書きで列挙する。\n';

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
  const date = new Date();
  const today = Utilities.formatDate(
    date,
    'Asia/Tokyo',
    'yyyy年M月d日',
  );

  // 曜日を取得 (0:日, 1:月, 2:火, 3:水, 4:木, 5:金, 6:土)
  const dayOfWeek = date.getDay();

  // 曜日に応じてテーマを分岐させる（例: 月・水・金でトリガーされると仮定）
  let promptFocus = 'AI分野（LLM、生成AI、機械学習、ロボティクス等）全般';
  if (dayOfWeek === 1) { // 月曜日
    promptFocus = '「基盤モデルやLLMの最新研究・論文の動向」';
  } else if (dayOfWeek === 3) { // 水曜日
    promptFocus = '「オープンソースのAIツールや開発者向けエコシステムの動向」';
  } else if (dayOfWeek === 5) { // 金曜日
    promptFocus = '「AIのビジネス活用事例や新しいプロダクトのリリース」';
  }

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
                  'です。' +
                  promptFocus +
                  'にフォーカスして、今最も注目すべきトピックを1つ選び、' +
                  'Deep Researchエージェントへの具体的な調査指示を日本語で作成してください。\n\n' +
                  'ルール:\n' +
                  '- 調査対象を「今日から直近1週間以内の情報」に厳密に限定するよう指示に含めること\n' +
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
  const date = new Date();
  const today = Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd');
  const dayOfWeek = date.getDay();

  // 曜日に応じてカテゴリとタグのヒントを変える
  let categoryStr = 'ml';
  let tagHint = '（例 llm, generative-ai）';

  if (dayOfWeek === 1) { // 月曜：研究・論文
    categoryStr = 'ml';
    tagHint = '（例 paper, llm, base-model）';
  } else if (dayOfWeek === 3) { // 水曜：ツール
    categoryStr = 'tooling';
    tagHint = '（例 tools, open-source, framework）';
  } else if (dayOfWeek === 5) { // 金曜：ビジネス・プロダクト
    categoryStr = 'curation';
    tagHint = '（例 business, product, use-case）';
  }

  const schema = {
    type: "OBJECT",
    properties: {
      title: {
        type: "STRING",
        description: "記事のタイトル"
      },
      description: {
        type: "STRING",
        description: "記事の概要（1〜2文）"
      },
      tags: {
        type: "ARRAY",
        items: { type: "STRING" },
        description: "記事の内容から適切なものを抽出したタグ。英語スラッグ必須 " + tagHint
      },
      body: {
        type: "STRING",
        description: "記事の本文（Markdown形式）。ここにはフロントマターを含めないでください。"
      }
    },
    required: ["title", "description", "tags", "body"]
  };

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
                  '以下の調査結果をもとに技術ブログの記事を作成してください。\n\n' +
                  BLOG_MARKDOWN_RULES_ +
                  '\n' +
                  '調査結果:\n' +
                  researchResult,
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: schema
        }
      }),
    },
  );

  const data = JSON.parse(res.getContentText());
  const jsonOutput = JSON.parse(data.candidates[0].content.parts[0].text);

  // GAS側でフロントマターを組み立てる
  let content = '---\n';
  content += 'title: "' + jsonOutput.title.replace(/"/g, '\\"') + '"\n';
  content += 'description: "' + jsonOutput.description.replace(/"/g, '\\"') + '"\n';
  content += 'pubDate: "' + today + '"\n';
  content += 'category: ' + categoryStr + '\n';
  content += 'articleKind: weekly-brief\n';
  content += 'tags: ' + JSON.stringify(jsonOutput.tags || []) + '\n';
  content += '---\n\n';
  content += jsonOutput.body;

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
