const STORAGE_KEY = "pulsechat-data";

const seededData = {
  chats: [
    {
      id: crypto.randomUUID(),
      name: "Alex",
      messages: [
        {
          id: crypto.randomUUID(),
          text: "Welcome to PulseChat!",
          sender: "them",
          sentAt: new Date().toISOString(),
        },
      ],
    },
  ],
};

const chatList = document.getElementById("chat-list");
const messageList = document.getElementById("message-list");
const chatTitle = document.getElementById("chat-title");
const chatStatus = document.getElementById("chat-status");
const newChatForm = document.getElementById("new-chat-form");
const chatNameInput = document.getElementById("chat-name");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const chatItemTemplate = document.getElementById("chat-item-template");
const messageItemTemplate = document.getElementById("message-item-template");

const appState = {
  data: loadData(),
  activeChatId: null,
};

if (appState.data.chats.length > 0) {
  appState.activeChatId = appState.data.chats[0].id;
}

render();

newChatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = chatNameInput.value.trim();
  if (!name) return;

  const chat = {
    id: crypto.randomUUID(),
    name,
    messages: [],
  };

  appState.data.chats.unshift(chat);
  appState.activeChatId = chat.id;
  chatNameInput.value = "";
  persist();
  render();
});

messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  const chat = getActiveChat();
  if (!chat || !text) return;

  chat.messages.push({
    id: crypto.randomUUID(),
    text,
    sender: "me",
    sentAt: new Date().toISOString(),
  });

  messageInput.value = "";
  persist();
  renderMessages(chat);

  window.setTimeout(() => {
    chat.messages.push({
      id: crypto.randomUUID(),
      text: "Auto-reply: Got it 👍",
      sender: "them",
      sentAt: new Date().toISOString(),
    });
    persist();
    renderMessages(chat);
    renderChatList();
  }, 650);
});

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(seededData);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.chats)) return structuredClone(seededData);
    return parsed;
  } catch {
    return structuredClone(seededData);
  }
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState.data));
}

function getActiveChat() {
  return appState.data.chats.find((chat) => chat.id === appState.activeChatId) ?? null;
}

function render() {
  renderChatList();
  const chat = getActiveChat();
  renderMessages(chat);
}

function renderChatList() {
  chatList.innerHTML = "";

  appState.data.chats.forEach((chat) => {
    const node = chatItemTemplate.content.cloneNode(true);
    const button = node.querySelector("button");
    const nameEl = node.querySelector(".chat-name");
    const previewEl = node.querySelector(".chat-preview");

    nameEl.textContent = chat.name;
    const lastMessage = chat.messages.at(-1);
    previewEl.textContent = lastMessage ? lastMessage.text : "No messages yet.";

    if (chat.id === appState.activeChatId) {
      button.classList.add("active");
    }

    button.addEventListener("click", () => {
      appState.activeChatId = chat.id;
      render();
    });

    chatList.append(node);
  });
}

function renderMessages(chat) {
  messageList.innerHTML = "";

  if (!chat) {
    chatTitle.textContent = "Choose a chat";
    chatStatus.textContent = "Create a chat to start messaging.";
    return;
  }

  chatTitle.textContent = chat.name;
  chatStatus.textContent = `${chat.messages.length} message${chat.messages.length === 1 ? "" : "s"}`;

  chat.messages.forEach((message) => {
    const node = messageItemTemplate.content.cloneNode(true);
    const item = node.querySelector(".message-item");
    const textEl = node.querySelector(".message-text");
    const timeEl = node.querySelector(".message-time");

    if (message.sender === "them") {
      item.classList.add("reply");
    }

    textEl.textContent = message.text;
    timeEl.textContent = new Date(message.sentAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    messageList.append(node);
  });

  messageList.scrollTop = messageList.scrollHeight;
}
