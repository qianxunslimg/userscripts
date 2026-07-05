import "./styles.css";
import { repositoryUrl, scripts } from "./scripts";

const app = document.querySelector("#app");
const basePath = import.meta.env.BASE_URL.endsWith("/")
  ? import.meta.env.BASE_URL
  : `${import.meta.env.BASE_URL}/`;

let activeCategory = "all";
let query = "";
let selectedKey = scripts[0]?.key || "";

function scriptUrl(script) {
  return `${basePath}${script.file}`;
}

function sourceUrl(script) {
  return `${repositoryUrl}/blob/main/${script.sourcePath}`;
}

function absoluteScriptUrl(script) {
  return new URL(scriptUrl(script), window.location.origin).toString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function categoryList() {
  return ["all", ...Array.from(new Set(scripts.map((script) => script.category)))];
}

function filteredScripts() {
  const normalizedQuery = query.trim().toLowerCase();
  return scripts.filter((script) => {
    const categoryMatched = activeCategory === "all" || script.category === activeCategory;
    if (!categoryMatched) return false;
    if (!normalizedQuery) return true;
    const haystack = [
      script.title,
      script.cnTitle,
      script.summary,
      script.category,
      script.tags.join(" "),
      script.matches.join(" "),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

function renderTags(tags) {
  return tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
}

function renderCategories() {
  return categoryList()
    .map((category) => {
      const label = category === "all" ? "全部" : category;
      return `
        <button class="filter ${category === activeCategory ? "is-active" : ""}" type="button" data-category="${escapeHtml(category)}">
          ${escapeHtml(label)}
        </button>
      `;
    })
    .join("");
}

function renderCards(items) {
  if (items.length === 0) {
    return `
      <section class="empty-state">
        <span class="empty-mark">?</span>
        <h2>没有匹配的脚本</h2>
        <p>换个关键词，或者切回全部分类。</p>
      </section>
    `;
  }

  return items
    .map((script) => `
      <article class="script-card ${script.key === selectedKey ? "is-selected" : ""}" data-script="${escapeHtml(script.key)}">
        <div class="card-topline">
          <span class="card-category">${escapeHtml(script.category)}</span>
          <span class="card-version">v${escapeHtml(script.version)}</span>
        </div>
        <h2>${escapeHtml(script.cnTitle)}</h2>
        <p class="card-title">${escapeHtml(script.title)}</p>
        <p class="card-summary">${escapeHtml(script.summary)}</p>
        <div class="tag-list">${renderTags(script.tags)}</div>
        <div class="card-actions">
          <a class="primary-action" href="${escapeHtml(scriptUrl(script))}" target="_blank" rel="noreferrer">安装脚本</a>
          <button class="ghost-action" type="button" data-copy="${escapeHtml(script.key)}">复制链接</button>
        </div>
      </article>
    `)
    .join("");
}

function renderDetail(script) {
  if (!script) {
    return `
      <aside class="detail-panel">
        <p>选择一个脚本查看详情。</p>
      </aside>
    `;
  }

  return `
    <aside class="detail-panel">
      <div class="detail-kicker">selected script</div>
      <h2>${escapeHtml(script.cnTitle)}</h2>
      <p class="detail-summary">${escapeHtml(script.why)}</p>

      <dl class="meta-grid">
        <div>
          <dt>状态</dt>
          <dd>${escapeHtml(script.status)}</dd>
        </div>
        <div>
          <dt>更新</dt>
          <dd>${escapeHtml(script.updated)}</dd>
        </div>
        <div>
          <dt>运行时机</dt>
          <dd>${escapeHtml(script.runAt)}</dd>
        </div>
      </dl>

      <section class="detail-section">
        <h3>匹配页面</h3>
        <ul class="code-list">
          ${script.matches.map((match) => `<li>${escapeHtml(match)}</li>`).join("")}
        </ul>
      </section>

      <section class="detail-section">
        <h3>权限</h3>
        <ul class="code-list">
          ${script.grants.map((grant) => `<li>${escapeHtml(grant)}</li>`).join("")}
        </ul>
      </section>

      <section class="install-box">
        <h3>安装方式</h3>
        <p>${escapeHtml(script.installNote)}</p>
        <a class="install-link" href="${escapeHtml(scriptUrl(script))}" target="_blank" rel="noreferrer">打开 .user.js</a>
        <a class="source-link" href="${escapeHtml(sourceUrl(script))}" target="_blank" rel="noreferrer">查看源码</a>
      </section>
    </aside>
  `;
}

function render() {
  const items = filteredScripts();
  if (!items.some((script) => script.key === selectedKey)) {
    selectedKey = items[0]?.key || scripts[0]?.key || "";
  }
  const selectedScript = scripts.find((script) => script.key === selectedKey);

  app.innerHTML = `
    <main class="shell">
      <header class="hero">
        <a class="back-link" href="/" aria-label="返回 almoststable 首页">as</a>
        <div class="hero-copy">
          <p class="eyebrow">Userscripts by qxslimg</p>
          <h1>油猴脚本库</h1>
          <p>收纳我自己写的浏览器增强脚本。当前只有一个脚本，但这里按长期维护的目录设计：搜索、分类、详情和安装入口都可以直接扩展。</p>
        </div>
        <div class="hero-stats">
          <div><strong>${scripts.length}</strong><span>脚本</span></div>
          <div><strong>${categoryList().length - 1}</strong><span>分类</span></div>
          <div><strong>0</strong><span>后端依赖</span></div>
        </div>
      </header>

      <section class="toolbar">
        <label class="search-box">
          <span>搜索</span>
          <input id="script-search" type="search" value="${escapeHtml(query)}" placeholder="名称、标签、匹配域名">
        </label>
        <div class="filters" aria-label="脚本分类">
          ${renderCategories()}
        </div>
      </section>

      <section class="content-grid">
        <div class="script-grid">
          ${renderCards(items)}
        </div>
        ${renderDetail(selectedScript)}
      </section>
    </main>
  `;

  bindEvents();
}

function bindEvents() {
  document.querySelector("#script-search")?.addEventListener("input", (event) => {
    query = event.target.value;
    render();
  });

  document.querySelectorAll("[data-category]").forEach((button) => {
    button.addEventListener("click", () => {
      activeCategory = button.dataset.category || "all";
      render();
    });
  });

  document.querySelectorAll("[data-script]").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest("a, button")) return;
      selectedKey = card.dataset.script || selectedKey;
      render();
    });
  });

  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const script = scripts.find((item) => item.key === button.dataset.copy);
      if (!script) return;
      const value = absoluteScriptUrl(script);
      try {
        await navigator.clipboard.writeText(value);
        button.textContent = "已复制";
      } catch {
        window.prompt("复制安装链接", value);
      }
      window.setTimeout(() => {
        button.textContent = "复制链接";
      }, 1400);
    });
  });
}

render();
