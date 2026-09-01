import { config } from "./config.js";

const $ = (id) => document.getElementById(id);
const state = {
  db: null,
  owner: null,
  posts: [],
  categories: [],
  categoryFilter: "",
  guests: [],
  month: new Date(),
  busy: false,
};
const fallbackProfile = {
  name: "비둘기",
  handle: "@eyecntct",
  intro: "작고 사적인 날들의 기록",
};
const cleanText = (value, fallback = "") =>
  typeof value === "string" ? value : fallback;
const dateKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const formatDate = (value) =>
  new Intl.DateTimeFormat("ko-KR", {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(`${value}T00:00:00`));
function notice(message) {
  $("status").textContent = message || "";
}
function escapeHtml(value) {
  const node = document.createElement("span");
  node.textContent = cleanText(value);
  return node.innerHTML;
}
function plainText(html) {
  const node = document.createElement("div");
  node.innerHTML = cleanText(html);
  return node.textContent.trim();
}
function normalizeColor(value, fallback = "#777777") {
  return /^#[0-9a-f]{6}$/i.test(cleanText(value))
    ? value.toUpperCase()
    : fallback;
}
function normalizeCategory(category) {
  return {
    ...category,
    name: cleanText(category?.name).trim(),
    color: normalizeColor(category?.color),
  };
}
function categoryForPost(post) {
  return (
    state.categories.find((category) => category.id === post.categoryId) || {
      name: cleanText(post.category, "미분류").trim() || "미분류",
      color: normalizeColor(post.categoryColor),
    }
  );
}
function markdownImage(markdown) {
  const match = /!\[[^\]]*\]\((https:\/\/media\.naru\.pub\/[^\s)]+)\)/.exec(
    cleanText(markdown),
  );
  return match?.[1] || "";
}
function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(
      /!\[([^\]]*)\]\((https:\/\/media\.naru\.pub\/[^\s)]+)\)/g,
      '<img src="$2" alt="$1">',
    )
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>',
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}
function markdownToHtml(markdown) {
  const lines = cleanText(markdown).replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let list = false;
  for (const line of lines) {
    if (/^[-*] /.test(line)) {
      if (!list) output.push("<ul>");
      list = true;
      output.push(`<li>${inlineMarkdown(line.slice(2))}</li>`);
      continue;
    }
    if (list) {
      output.push("</ul>");
      list = false;
    }
    if (line.startsWith("## "))
      output.push(`<h2>${inlineMarkdown(line.slice(3))}</h2>`);
    else if (line.startsWith("### "))
      output.push(`<h3>${inlineMarkdown(line.slice(4))}</h3>`);
    else if (line.startsWith("> "))
      output.push(`<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`);
    else if (line.trim()) output.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  if (list) output.push("</ul>");
  return safeHtml(output.join(""));
}
function postHtml(post) {
  return typeof post.bodyMarkdown === "string"
    ? markdownToHtml(post.bodyMarkdown)
    : safeHtml(post.bodyHtml);
}
function postText(post) {
  return typeof post.bodyMarkdown === "string"
    ? post.bodyMarkdown.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    : plainText(post.bodyHtml);
}
function safeHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = cleanText(html);
  const allowed = new Set([
    "P",
    "BR",
    "B",
    "STRONG",
    "I",
    "EM",
    "H2",
    "H3",
    "UL",
    "OL",
    "LI",
    "A",
    "IMG",
    "BLOCKQUOTE",
  ]);
  [...template.content.querySelectorAll("*")].forEach((node) => {
    if (!allowed.has(node.tagName)) {
      node.replaceWith(...node.childNodes);
      return;
    }
    [...node.attributes].forEach((attr) => {
      if (!["href", "src", "alt"].includes(attr.name))
        node.removeAttribute(attr.name);
    });
    if (node.tagName === "A") {
      try {
        const url = new URL(node.href);
        if (!["http:", "https:"].includes(url.protocol))
          node.removeAttribute("href");
      } catch {
        node.removeAttribute("href");
      }
      node.rel = "noopener";
      node.target = "_blank";
    }
    if (
      node.tagName === "IMG" &&
      !/^https:\/\/media\.naru\.pub\//.test(node.getAttribute("src") || "")
    )
      node.remove();
  });
  return template.innerHTML;
}
async function connect() {
  if (!config.site)
    throw new Error("config.js에 나루 로그인 이름을 입력하세요.");
  const { createDatabase } =
    await import("https://naru.pub/sdk/1.0.0/naru-data.js?media=1");
  return createDatabase({ site: config.site });
}
async function listAll(collection, options = {}) {
  const documents = [];
  let after;
  do {
    const page = await collection.list({
      limit: 100,
      ...options,
      ...(after ? { after } : {}),
    });
    documents.push(...page.documents);
    after = page.nextCursor;
  } while (after && documents.length < 1000);
  return documents;
}
function postsFromDocuments(documents) {
  return documents.map((doc) => {
    const data =
      doc.data && typeof doc.data === "object" && !Array.isArray(doc.data)
        ? doc.data
        : {};
    return { id: doc.id, createdAt: doc.created_at, ...data };
  });
}
async function loadPosts(categoryId = "") {
  const documents = await listAll(state.db.collection("posts"), {
    orderBy: "created_at",
    direction: "desc",
    ...(categoryId ? { where: { categoryId } } : {}),
  });
  state.categoryFilter = categoryId;
  state.posts = postsFromDocuments(documents);
}
async function load() {
  try {
    state.db = await connect();
    state.owner = await state.db.completeOwnerSignIn();
    const [posts, categories, guests, profile] = await Promise.all([
      listAll(state.db.collection("posts"), {
        orderBy: "created_at",
        direction: "desc",
      }),
      listAll(state.db.collection("categories")),
      listAll(state.db.collection("guestbook"), {
        orderBy: "created_at",
        direction: "desc",
      }),
      state.db
        .collection("site")
        .get("profile")
        .catch(() => null),
    ]);
    state.categories = categories
      .map((doc) => normalizeCategory({ id: doc.id, ...doc.data }))
      .filter((category) => category.name)
      .sort((a, b) => a.name.localeCompare(b.name, "ko"));
    state.posts = postsFromDocuments(posts);
    state.guests = guests.map((doc) => ({
      id: doc.id,
      createdAt: doc.created_at,
      ...doc.data,
    }));
    let migrated = 0;
    if (state.owner) {
      try {
        for (const category of state.categories) {
          const source = categories.find((doc) => doc.id === category.id)?.data;
          if (
            source?.name !== category.name ||
            source?.color !== category.color
          )
            await state.owner.collection("categories").set(category.id, {
              name: category.name,
              color: category.color,
            });
        }
        for (const post of state.posts) {
          if (
            post.categoryId &&
            state.categories.some((category) => category.id === post.categoryId)
          )
            continue;
          const legacy = categoryForPost(post);
          let category = state.categories.find(
            (item) =>
              item.name.localeCompare(legacy.name, "ko", {
                sensitivity: "base",
              }) === 0,
          );
          if (!category) {
            category = {
              id: crypto.randomUUID(),
              ...normalizeCategory(legacy),
            };
            await state.owner.collection("categories").set(category.id, {
              name: category.name,
              color: category.color,
            });
            state.categories.push(category);
          }
          const data = { ...post, categoryId: category.id };
          delete data.id;
          delete data.createdAt;
          delete data.category;
          delete data.categoryColor;
          await state.owner.collection("posts").set(post.id, data);
          post.categoryId = category.id;
          delete post.category;
          delete post.categoryColor;
          migrated += 1;
        }
        state.categories.sort((a, b) => a.name.localeCompare(b.name, "ko"));
      } catch (error) {
        notice(
          `글은 불러왔지만 카테고리 마이그레이션을 저장하지 못했습니다. ${error.message || error}`,
        );
      }
    }
    populateCategoryOptions();
    populateCategoryFilter();
    renderProfile(profile?.data || fallbackProfile);
    render();
    setOwnerUI();
    if (migrated)
      notice(`${migrated}개 글의 카테고리를 데이터베이스로 옮겼습니다.`);
    else if (!$("status").textContent.includes("못했습니다")) notice("");
  } catch (error) {
    renderProfile(fallbackProfile);
    render();
    notice(`기록을 불러오지 못했습니다. ${error.message || error}`);
  }
}
function renderProfile(profile) {
  $("profileName").textContent = cleanText(profile.name, fallbackProfile.name);
  $("profileHandle").textContent = cleanText(
    profile.handle,
    fallbackProfile.handle,
  );
  $("profileIntro").textContent = cleanText(
    profile.intro,
    fallbackProfile.intro,
  );
}
function render() {
  renderFeatured();
  renderCalendar();
  renderGuests();
}
function coverFrom(post) {
  if (typeof post.bodyMarkdown === "string")
    return cleanText(post.coverImage) || markdownImage(post.bodyMarkdown);
  const template = document.createElement("template");
  template.innerHTML = safeHtml(post.bodyHtml);
  return (
    cleanText(post.coverImage) ||
    template.content.querySelector("img")?.src ||
    ""
  );
}
function renderFeatured() {
  const root = $("featuredPosts");
  root.replaceChildren();
  if (!state.posts.length) {
    root.innerHTML = `<div class="empty-card">${state.categoryFilter ? "이 카테고리에는 아직 기록이 없어요." : "아직 둥지에 기록이 없어요."}</div>`;
    return;
  }
  state.posts.slice(0, 8).forEach((post) => {
    const article = document.createElement("article");
    article.className = "post-card";
    const category = categoryForPost(post);
    article.style.setProperty("--category", category.color);
    const image = coverFrom(post);
    article.innerHTML = `<button type="button"><div class="card-meta"><span class="category">${escapeHtml(category.name)}</span><time>${escapeHtml(formatDate(post.date))}</time></div><h3>${escapeHtml(post.title || "제목 없는 기록")}</h3><p class="excerpt">${escapeHtml(postText(post).slice(0, 110))}</p>${image ? `<img class="cover" src="${image}" alt="" />` : '<div class="cover cover-placeholder">비둘기 둥지</div>'}</button>`;
    article.querySelector("button").onclick = () => openPost(post);
    root.append(article);
  });
}
function renderCalendar() {
  const year = state.month.getFullYear(),
    month = state.month.getMonth();
  $("calendarYear").textContent = year;
  $("calendarMonth").textContent = month + 1;
  const first = new Date(year, month, 1),
    start = new Date(year, month, 1 - first.getDay()),
    today = dateKey(new Date());
  const grid = $("calendarGrid");
  grid.replaceChildren();
  for (let i = 0; i < 42; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const key = dateKey(day);
    const cell = document.createElement("div");
    cell.className = `calendar-day${day.getMonth() !== month ? " muted" : ""}${key === today ? " today" : ""}`;
    cell.innerHTML = `<div class="day-number">${day.getDate()}</div>`;
    state.posts
      .filter((post) => post.date === key)
      .slice(0, 3)
      .forEach((post) => {
        const button = document.createElement("button");
        button.className = "day-post";
        const category = categoryForPost(post);
        button.style.setProperty("--category", category.color);
        button.textContent = post.title || category.name;
        button.onclick = () => openPost(post);
        cell.append(button);
      });
    grid.append(cell);
  }
}
function openPost(post) {
  const detail = $("postDetail"),
    image = coverFrom(post);
  const category = categoryForPost(post);
  detail.innerHTML = `<p class="eyebrow" style="color:${category.color}">${escapeHtml(category.name)}${post.subcategory ? ` · ${escapeHtml(post.subcategory)}` : ""}</p><h2>${escapeHtml(post.title || "제목 없는 기록")}</h2><time>${escapeHtml(formatDate(post.date))}</time>${image ? `<img class="post-detail-cover" src="${image}" alt="" />` : ""}<div class="post-body">${postHtml(post)}</div>${state.owner ? '<p><button class="text-button" id="editCurrentPost" type="button">이 글 수정</button></p>' : ""}`;
  $("postDialog").showModal();
  $("editCurrentPost")?.addEventListener("click", () => {
    $("postDialog").close();
    openEditor(post);
  });
}
function renderGuests() {
  const root = $("guestList");
  root.replaceChildren();
  state.guests.forEach((guest) => {
    const item = document.createElement("div");
    item.className = "guest-entry";
    item.innerHTML = `<strong>${escapeHtml(guest.name || "익명")}</strong> <time>${new Date(guest.createdAt).toLocaleDateString("ko-KR")}</time><p>${escapeHtml(guest.message)}</p>`;
    root.append(item);
  });
}
function setOwnerUI() {
  document
    .querySelectorAll(".owner-only")
    .forEach((el) => (el.hidden = !state.owner));
  $("loginButton").textContent = state.owner ? "로그아웃" : "로그인";
}
async function ownerAction(action) {
  if (state.busy) return;
  state.busy = true;
  try {
    await action();
  } catch (error) {
    notice(error.message || String(error));
  } finally {
    state.busy = false;
  }
}
function populateCategoryOptions() {
  $("categoryInput").replaceChildren(
    ...state.categories.map((category) => {
      const option = document.createElement("option");
      option.value = category.id;
      option.textContent = category.name;
      return option;
    }),
  );
  const custom = document.createElement("option");
  custom.value = "__new";
  custom.textContent = "새 카테고리…";
  $("categoryInput").append(custom);
}
function populateCategoryFilter() {
  const select = $("categoryFilter");
  select.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "전체 기록";
  select.append(all);
  for (const category of state.categories) {
    const option = document.createElement("option");
    option.value = category.id;
    option.textContent = category.name;
    select.append(option);
  }
  select.value = state.categories.some(
    (category) => category.id === state.categoryFilter,
  )
    ? state.categoryFilter
    : "";
}
function syncCategoryEditor() {
  const custom = $("categoryInput").value === "__new";
  $("newCategoryInput").disabled = !custom;
  $("colorInput").disabled = !custom;
  if (!custom)
    $("colorInput").value =
      state.categories.find(
        (category) => category.id === $("categoryInput").value,
      )?.color || "#777777";
}
function openEditor(post = null) {
  $("editorForm").reset();
  $("postId").value = post?.id || "";
  $("editorTitle").textContent = post ? "기록 수정" : "새 기록";
  $("titleInput").value = cleanText(post?.title);
  $("dateInput").value = post?.date || dateKey(new Date());
  const category = post ? categoryForPost(post) : state.categories[0];
  $("categoryInput").value = category?.id || "__new";
  $("newCategoryInput").value =
    $("categoryInput").value === "__new" ? category?.name || "" : "";
  $("colorInput").value = category?.color || "#777777";
  syncCategoryEditor();
  $("subcategoryInput").value = cleanText(post?.subcategory);
  $("bodyInput").value =
    typeof post?.bodyMarkdown === "string"
      ? post.bodyMarkdown
      : plainText(post?.bodyHtml);
  $("deleteButton").hidden = !post;
  $("editorDialog").showModal();
}
$("loginButton").onclick = () =>
  ownerAction(async () => {
    if (state.owner) {
      await state.owner.signOut();
      state.owner = null;
      setOwnerUI();
      notice("로그아웃했습니다.");
      return;
    }
    await state.db.signInAsOwner({
      ...(config.clientId ? { clientId: config.clientId } : {}),
      redirectUri: location.origin + location.pathname,
      collections: ["posts", "categories", "site", "guestbook"],
    });
  });
$("newPostButton").onclick = () => openEditor();
$("guestbookButton").onclick = () => $("guestbookDialog").showModal();
document
  .querySelectorAll("[data-close]")
  .forEach(
    (button) => (button.onclick = () => button.closest("dialog").close()),
  );
$("previousMonth").onclick = () => {
  state.month = new Date(
    state.month.getFullYear(),
    state.month.getMonth() - 1,
    1,
  );
  renderCalendar();
};
$("nextMonth").onclick = () => {
  state.month = new Date(
    state.month.getFullYear(),
    state.month.getMonth() + 1,
    1,
  );
  renderCalendar();
};
$("todayButton").onclick = () => {
  state.month = new Date();
  renderCalendar();
};
$("categoryInput").onchange = () => {
  syncCategoryEditor();
  if (!$("newCategoryInput").disabled) $("newCategoryInput").focus();
};
$("categoryFilter").onchange = async (event) => {
  if (state.busy) return;
  state.busy = true;
  const select = event.currentTarget;
  select.disabled = true;
  notice("카테고리 기록을 불러오고 있습니다…");
  try {
    await loadPosts(select.value);
    renderFeatured();
    renderCalendar();
    notice(
      `${select.selectedOptions[0].textContent} · ${state.posts.length}개 기록`,
    );
  } catch (error) {
    select.value = state.categoryFilter;
    notice(`카테고리를 불러오지 못했습니다. ${error.message || error}`);
  } finally {
    select.disabled = false;
    state.busy = false;
  }
};
function insertEditorText(before, after = "", placeholder = "텍스트") {
  const editor = $("bodyInput");
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const selected = editor.value.slice(start, end) || placeholder;
  editor.setRangeText(before + selected + after, start, end, "end");
  editor.focus();
}
document.querySelectorAll("[data-command]").forEach((button) => {
  button.onclick = () => {
    const command = button.dataset.command;
    if (command === "bold") insertEditorText("**", "**");
    else if (command === "italic") insertEditorText("*", "*");
    else if (command === "formatBlock")
      insertEditorText(button.dataset.value === "h2" ? "## " : "### ", "");
    else if (command === "insertUnorderedList") insertEditorText("- ", "");
  };
});
$("imageInput").onchange = async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  await ownerAction(async () => {
    if (!state.owner) throw new Error("관리자 로그인이 필요합니다.");
    if (!state.owner.files?.upload)
      throw new Error("새 SDK를 불러오지 못했습니다. 페이지를 새로고침하세요.");
    notice("이미지를 업로드하고 있습니다…");
    const alt = file.name.replace(/\.[^.]+$/, "").replace(/[\[\]]/g, "");
    const postId = $("postId").value || crypto.randomUUID();
    $("postId").value = postId;
    const stored = await state.owner.files.upload(file, {
      onProgress: ({ loaded, total }) =>
        notice(`이미지 업로드 중… ${Math.round((loaded / total) * 100)}%`),
      metadata: {
        altText: alt,
        references: [
          { collection: "posts", id: postId, field: "bodyMarkdown" },
        ],
      },
    });
    insertEditorText(`![${alt}](${stored.url})\n`, "", "");
    event.target.value = "";
    notice("이미지를 업로드하고 마크다운을 본문에 추가했습니다.");
  });
};
$("editorForm").onsubmit = (event) => {
  event.preventDefault();
  ownerAction(async () => {
    if (!state.owner) throw new Error("관리자 로그인이 필요합니다.");
    const id = $("postId").value || crypto.randomUUID();
    let category = state.categories.find(
      (item) => item.id === $("categoryInput").value,
    );
    let newCategory = false;
    if (!category) {
      category = normalizeCategory({
        id: crypto.randomUUID(),
        name: $("newCategoryInput").value,
        color: $("colorInput").value,
      });
      if (!category.name) throw new Error("카테고리 이름을 입력하세요.");
      const duplicate = state.categories.find(
        (item) =>
          item.name.localeCompare(category.name, "ko", {
            sensitivity: "base",
          }) === 0,
      );
      if (duplicate) category = duplicate;
      else {
        newCategory = true;
      }
    }
    const bodyMarkdown = $("bodyInput").value.trim();
    if (!bodyMarkdown) throw new Error("본문을 입력하세요.");
    const post = {
      title: $("titleInput").value.trim(),
      date: $("dateInput").value,
      categoryId: category.id,
      subcategory: $("subcategoryInput").value.trim(),
      bodyMarkdown,
      coverImage: markdownImage(bodyMarkdown),
    };
    if (newCategory) {
      await state.owner.batch([
        {
          type: "set",
          collection: "categories",
          id: category.id,
          data: { name: category.name, color: category.color },
        },
        { type: "set", collection: "posts", id, data: post },
      ]);
      state.categories.push(category);
      state.categories.sort((a, b) => a.name.localeCompare(b.name, "ko"));
      populateCategoryOptions();
      populateCategoryFilter();
    } else await state.owner.collection("posts").set(id, post);
    const existing = state.posts.findIndex((p) => p.id === id);
    const visible =
      !state.categoryFilter || post.categoryId === state.categoryFilter;
    if (!visible && existing >= 0) state.posts.splice(existing, 1);
    else if (existing >= 0)
      state.posts[existing] = { ...state.posts[existing], ...post };
    else if (visible)
      state.posts.unshift({ id, createdAt: new Date().toISOString(), ...post });
    $("editorDialog").close();
    render();
    notice("기록을 저장했습니다.");
  });
};
$("deleteButton").onclick = () =>
  ownerAction(async () => {
    const id = $("postId").value;
    if (!id || !state.owner || !confirm("이 기록을 삭제할까요?")) return;
    await state.owner.collection("posts").delete(id);
    state.posts = state.posts.filter((p) => p.id !== id);
    $("editorDialog").close();
    render();
    notice("기록을 삭제했습니다.");
  });
$("guestbookForm").onsubmit = (event) => {
  event.preventDefault();
  ownerAction(async () => {
    state.db ??= await connect();
    const entry = {
      name: $("guestName").value.trim(),
      message: $("guestMessage").value.trim(),
    };
    const result = await state.db.collection("guestbook").add(entry);
    state.guests.unshift({
      id: result.id,
      createdAt: new Date().toISOString(),
      ...entry,
    });
    event.target.reset();
    renderGuests();
    notice("방명록을 남겼습니다.");
  });
};
await load();
