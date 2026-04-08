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

/**
 * 曜日ごとのトピック設定 (0=日, 1=月, 2=火, 3=水, 4=木, 5=金, 6=土)
 * focus       : selectTopic_ がプロンプトに埋め込むテーマ指定文
 * researchGuide: より具体的な調査ガイドライン
 * category    : Astroフロントマターの category 値
 * tagHint     : formatBlogPost_ がタグ生成時に参考にするヒント
 */
const DAILY_TOPICS_ = {
  0: {
    name: 'マルチモーダル・生成AI',
    focus: '「マルチモーダルAI・画像/動画/音楽生成AIの最新動向」（Stable Diffusion系、VideoGenモデル、3D生成、画像編集AIなど）',
    researchGuide: '対象例: Stability AI / Runway / Kling / Sora / Wan / HiDream / MusicGen 等。新モデルのリリース・性能比較・ユニークなユースケースに着目すること。',
    category: 'curation',
    tagHint: '（例 multimodal, image-gen, video-gen, generative-ai）',
  },
  1: {
    name: 'メジャーLab最新情報',
    focus: '「OpenAI / Anthropic / Google DeepMind / Microsoft によるAI分野の最新動向」',
    researchGuide: '新規モデルのリリース（weights公開・API提供どちらも対象）、公式ブログ記事、研究発表、製品アップデート、業界への影響に着目すること。',
    category: 'curation',
    tagHint: '（例 openai, anthropic, deepmind, microsoft, llm）',
  },
  2: {
    name: 'OSSモデル最新情報',
    focus: '「Meta / DeepSeek / GLM / miniMAX / Qwen / Kimi / Mistral 等のオープンソースモデル勢の最新動向」',
    researchGuide: '新モデルのリリース、Hugging Face公開状況、ベンチマーク結果、コミュニティの反応・注目ユースケースに着目すること。',
    category: 'curation',
    tagHint: '（例 open-source, meta, deepseek, qwen, mistral, llm）',
  },
  3: {
    name: 'ML/LLM最新研究・論文',
    focus: '「基盤モデルやLLMに関する最新の研究・論文の動向」',
    researchGuide: 'arxiv や NeurIPS/ICML/ICLR 等の注目論文、新アーキテクチャ、学習手法（RLHF/DPO等）、アライメント、推論能力、ベンチマークに着目すること。',
    category: 'ml',
    tagHint: '（例 paper, llm, research, base-model, alignment）',
  },
  4: {
    name: '音声AI最新情報',
    focus: '「STT（音声認識）/ TTS（音声合成）/ ASR / 音声AIの新しいモデルやツールの動向」',
    researchGuide: '新モデルのリリース・性能比較、日本語対応の有無と品質、リアルタイム性能、感情表現・多言語対応、オープンソースの動向に特に着目すること。',
    category: 'ml',
    tagHint: '（例 speech, tts, stt, asr, audio-ai, japanese）',
  },
  5: {
    name: 'OSSツール・エコシステム',
    focus: '「オープンソースのAI開発ツール・フレームワーク・エコシステムの最新動向」',
    researchGuide: '新規ツールのリリース、既存ツールの重要アップデート（LangChain / LlamaIndex / vLLM / Ollama 等）、開発者体験の向上、MLOps関連の動向に着目すること。',
    category: 'tooling',
    tagHint: '（例 tools, open-source, framework, developer, mlops）',
  },
  6: {
    name: 'AIエージェント動向',
    focus: '「AIエージェント・マルチエージェントシステムの最新動向」',
    researchGuide: '自律エージェントのフレームワーク（AutoGen / CrewAI / LangGraph 等）、新実装事例、ベンチマーク、Computer Use・Webエージェント、コーディングエージェントの動向に着目すること。',
    category: 'ml',
    tagHint: '（例 agent, multi-agent, autonomous, agentic-ai, framework）',
  },
};

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
  const today = Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy年M月d日');
  const dayOfWeek = date.getDay(); // 0=日, 1=月, ..., 6=土

  const topic = DAILY_TOPICS_[dayOfWeek];
  Logger.log('Today\'s theme: ' + topic.name);

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
                  '今日は' + today + 'です。' +
                  topic.focus + 'にフォーカスして、今最も注目すべきトピックを1つ選び、' +
                  'Deep Researchエージェントへの具体的な調査指示を日本語で作成してください。\n\n' +
                  'ルール:\n' +
                  '- 調査対象を「今日から直近1週間以内の情報」に厳密に限定するよう指示に含めること\n' +
                  '- ' + topic.researchGuide + '\n' +
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

  // 曜日に応じてカテゴリとタグのヒントを DAILY_TOPICS_ から取得
  const topic = DAILY_TOPICS_[dayOfWeek];
  const categoryStr = topic.category;
  const tagHint = topic.tagHint;

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
