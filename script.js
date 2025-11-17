// ===== MODAL DE IMAGEM =====
function openModal() {
  document.getElementById('imageModal').classList.add('active');
}

function closeModal() {
  document.getElementById('imageModal').classList.remove('active');
}

// Fechar com tecla ESC
document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape') {
    closeModal();
  }
});

// ===== CONFIG E SESSÃO =====
const config = {
  N8N_WEBHOOK_URL: 'https://flow.grupopanda.net.br/webhook/elton',
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 1000
};

const SESSION_KEY = 'elton_ti_session_id';
if (!localStorage.getItem(SESSION_KEY)) {
  localStorage.setItem(
    SESSION_KEY,
    'sess-' + Math.random().toString(36).slice(2) + Date.now()
  );
}
const sessionId = localStorage.getItem(SESSION_KEY);

// ===== CHAT =====
class ChatElton {
  constructor() {
    // Elementos principais
    this.messagesContainer = document.getElementById('messagesContainer');
    this.messageInput = document.getElementById('messageInput');
    this.sendBtn = document.getElementById('sendBtn');

    // Áudio
    this.micBtn = document.getElementById('micBtn');
    this.recordingHint = document.getElementById('recordingHint');
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.isRecording = false;

    // Anexos
    this.fileInput = document.getElementById('fileInput');
    this.attachBtn = document.getElementById('attachBtn');

    // Estado
    this.conversationHistory = [];
    this.isWaitingResponse = false;

    // Fila de anexos no compositor (não envia automático)
    this.pendingAttachments = []; // {file, url}

    // Container de preview de anexos do compositor
    this.attachPreview = document.createElement('div');
    this.attachPreview.id = 'attachPreview';
    this.attachPreview.className = 'attach-preview';

    // injeta o preview próximo ao input
    if (this.messageInput && this.messageInput.parentNode) {
      this.messageInput.parentNode.insertBefore(this.attachPreview, this.messageInput);
    }

    this.init();
  }

  init() {
    console.log('💻 Inicializando Chat Elton (Suporte TI)...');
    console.log('Sessão:', sessionId);
    this.attachEventListeners();
    this.loadConversationHistory();
    this.updateSendButtonState();
  }

  attachEventListeners() {
    // Enviar mensagem (texto + anexos pendentes)
    this.sendBtn.addEventListener('click', () => this.sendMessage());
    this.messageInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    this.messageInput.addEventListener('input', () => this.updateSendButtonState());

    // Áudio: gravar ao pressionar, parar ao soltar
    this.micBtn.addEventListener('mousedown', () => this.startRecording());
    this.micBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.startRecording();
    });
    document.addEventListener('mouseup', () => {
      if (this.isRecording) this.stopRecordingAndSend();
    });
    document.addEventListener('touchend', (e) => {
      if (this.isRecording) {
        e.preventDefault();
        this.stopRecordingAndSend();
      }
    });

    // 📎 Abrir seletor de arquivos
    if (this.attachBtn) {
      this.attachBtn.addEventListener('click', () => this.fileInput && this.fileInput.click());
    }

    // Input de arquivos (multi)
    if (this.fileInput) {
      this.fileInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files || []);
        if (files.length) this.queueIncomingFiles(files);
        this.fileInput.value = '';
      });
    }

    // 📋 PASTE: Ctrl+V/colar para anexar arquivos/imagens
    window.addEventListener('paste', (e) => {
      const files = [];

      // 1) Arquivos diretos do clipboard
      if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length) {
        for (const f of e.clipboardData.files) files.push(f);
      }

      // 2) Items (ex.: imagem/print do SO)
      if (!files.length && e.clipboardData && e.clipboardData.items) {
        for (const item of e.clipboardData.items) {
          if (item.kind === 'file') {
            const blob = item.getAsFile();
            if (blob) {
              const ext = (blob.type && blob.type.split('/')[1]) || 'bin';
              const named = new File([blob], `clipboard-${Date.now()}.${ext}`, { type: blob.type });
              files.push(named);
            }
          }
        }
      }

      if (files.length) {
        e.preventDefault(); // evita colar o nome no input
        this.queueIncomingFiles(files); // só coloca em fila
      }
    });
  }

  // ===== TEXTO + ANEXOS =====
  updateSendButtonState() {
    const hasText = (this.messageInput?.value || '').trim() !== '';
    const hasAttachments = this.pendingAttachments.length > 0;
    this.sendBtn.disabled = !(hasText || hasAttachments) || this.isWaitingResponse;
  }

  sendMessage() {
    const message = (this.messageInput.value || '').trim();
    const hasAttachments = this.pendingAttachments.length > 0;

    if (!message && !hasAttachments) return;
    if (this.isWaitingResponse) return;

    // faz uma cópia dos anexos atuais antes de limpar a fila
    const attachmentsToSend = [...this.pendingAttachments];

    // Renderiza no chat o que o usuário está enviando agora
    this.addMessage('user', {
      text: message || (hasAttachments ? 'Anexo(s) enviado(s).' : ''),
      attachments: attachmentsToSend.map(pa => pa.file)
    });

    this.conversationHistory.push({
      role: 'user',
      content: message || '[ANEXOS]'
    });
    this.saveConversationHistory();

    // Limpa compositor imediatamente (UX)
    this.messageInput.value = '';
    this.clearAttachmentQueue();
    this.updateSendButtonState();

    // Mostra digitando e envia
    this.showTypingIndicator();
    this.sendCombinedToN8N(message, attachmentsToSend);
  }

  // Envia em JSON quando for só texto; FormData quando houver arquivo
  async sendCombinedToN8N(userMessage, attachments = []) {
    this.isWaitingResponse = true;
    const hasFiles = attachments && attachments.length > 0;

    try {
      let response;

      if (!hasFiles) {
        // texto puro — JSON
        response = await fetch(config.N8N_WEBHOOK_URL, {
          method: 'POST',
          mode: 'cors',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'PandaFibra-ChatSuporteElton/1.0'
          },
          body: JSON.stringify({
            agent: 'elton-ti',
            type: 'support_message',
            message: userMessage,
            history: this.conversationHistory,
            sessionId,
            name: 'Colaborador ou Cliente',
            timestamp: new Date().toISOString(),
            inputFormat: 'text'
          })
        });
      } else {
        // texto + arquivos — multipart/form-data
        const formData = new FormData();
        formData.append('agent', 'elton-ti');
        formData.append('type', 'support_message');
        formData.append('sessionId', sessionId);
        formData.append('name', 'Colaborador ou Cliente');
        formData.append('timestamp', new Date().toISOString());
        formData.append('history', JSON.stringify(this.conversationHistory));
        formData.append('inputFormat', 'file');
        formData.append('message', userMessage || '');

        // envia todos os arquivos que estavam na fila no momento do envio
        for (const pa of attachments) {
          formData.append('files', pa.file, pa.file.name);
        }

        response = await fetch(config.N8N_WEBHOOK_URL, {
          method: 'POST',
          mode: 'cors',
          body: formData
        });
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

      const data = await this.parseN8NResponse(response);
      this.removeTypingIndicator();

      const aiText =
        data.responseText ||
        data.response ||
        data.message ||
        'Desculpe, houve um problema técnico ao processar sua mensagem.';

      const aiAudioUrl = data.responseAudioUrl || data.audioUrl || null;

      this.addMessage('assistant', { text: aiText, audioUrl: aiAudioUrl });

      let historyContent = aiText;
      if (aiAudioUrl) historyContent += ` [AUDIO RECEBIDO: ${aiAudioUrl}]`;
      this.conversationHistory.push({ role: 'assistant', content: historyContent });
      this.saveConversationHistory();
    } catch (error) {
      console.error('❌ Erro ao enviar mensagem:', error);
      this.removeTypingIndicator();
      this.addMessage('system', { text: `⚠️ Erro: ${error.message}` });
    } finally {
      this.isWaitingResponse = false;
      this.updateSendButtonState();
      this.messageInput.focus();
    }
  }

  async parseN8NResponse(response) {
    const contentType = response.headers.get('Content-Type') || '';

    if (contentType.includes('application/json')) {
      return await response.json();
    }

    if (contentType.includes('audio/')) {
      const audioBlobResponse = await response.blob();
      const localUrl = URL.createObjectURL(audioBlobResponse);
      return { responseText: 'Enviei a resposta em áudio 🎧', responseAudioUrl: localUrl };
    }

    const textResp = await response.text();
    throw new Error('Resposta inesperada do servidor: ' + textResp.slice(0, 120));
  }

  // ===== ÁUDIO =====
  async startRecording() {
    if (this.isWaitingResponse || this.isRecording) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioChunks = [];
      this.mediaRecorder = new MediaRecorder(stream);

      this.mediaRecorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      });

      this.isRecording = true;
      this.micBtn.classList.add('recording');
      this.recordingHint.classList.add('active');

      this.mediaRecorder.start();
      console.log('🎙️ Gravando áudio...');
    } catch (err) {
      console.error('🚫 Não conseguiu acessar microfone:', err);
      this.addMessage('system', {
        text: '⚠️ Não consegui acessar o microfone. Verifique as permissões.'
      });
    }
  }

  async stopRecordingAndSend() {
    if (!this.isRecording) return;
    this.isRecording = false;

    // volta UI ao normal
    this.micBtn.classList.remove('recording');
    this.recordingHint.classList.remove('active');

    if (!this.mediaRecorder) return;

    // para a gravação, espera finalizar, monta blob e envia
    this.mediaRecorder.addEventListener('stop', async () => {
      const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
      const audioUrlLocal = URL.createObjectURL(audioBlob);

      this.addMessage('user', {
        text: '[Áudio enviado]',
        audioUrl: audioUrlLocal
      });
      this.conversationHistory.push({
        role: 'user',
        content: '[AUDIO ENVIADO]'
      });
      this.saveConversationHistory();

      this.showTypingIndicator();
      await this.sendAudioToN8N(audioBlob);

      if (this.mediaRecorder.stream) {
        this.mediaRecorder.stream.getTracks().forEach(t => t.stop());
      }
      this.mediaRecorder = null;
      this.audioChunks = [];
    });

    this.mediaRecorder.stop();
  }

  async sendAudioToN8N(audioBlob) {
    this.isWaitingResponse = true;

    try {
      const formData = new FormData();
      formData.append('agent', 'elton-ti');
      formData.append('type', 'support_message');
      formData.append('sessionId', sessionId);
      formData.append('name', 'Colaborador ou Cliente');
      formData.append('timestamp', new Date().toISOString());
      formData.append('history', JSON.stringify(this.conversationHistory));
      formData.append('inputFormat', 'audio');
      formData.append('audio', audioBlob, 'gravacao.webm');

      const response = await fetch(config.N8N_WEBHOOK_URL, {
        method: 'POST',
        mode: 'cors',
        body: formData
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await this.parseN8NResponse(response);
      this.removeTypingIndicator();

      this.addMessage('assistant', {
        text: data.responseText || 'Recebi seu áudio e estou processando sua solicitação. ✅',
        audioUrl: data.responseAudioUrl || null
      });

      let historyContent = data.responseText || 'OK';
      if (data.responseAudioUrl) {
        historyContent += ` [AUDIO RECEBIDO: ${data.responseAudioUrl}]`;
      }
      this.conversationHistory.push({ role: 'assistant', content: historyContent });
      this.saveConversationHistory();

    } catch (error) {
      console.error('❌ Erro ao enviar áudio:', error);
      this.removeTypingIndicator();
      this.addMessage('system', { text: `⚠️ Erro no envio de áudio: ${error.message}` });
    } finally {
      this.isWaitingResponse = false;
      this.updateSendButtonState();
      this.messageInput.focus();
    }
  }

  // ===== ANEXOS (fila do compositor) =====
  queueIncomingFiles(files) {
    for (const file of files) {
      // cria URL pra preview
      const url = URL.createObjectURL(file);
      this.pendingAttachments.push({ file, url });
    }
    this.renderAttachmentPreviews();
    this.updateSendButtonState();
  }

  removeQueuedAttachment(index) {
    const item = this.pendingAttachments[index];
    if (item?.url) URL.revokeObjectURL(item.url);
    this.pendingAttachments.splice(index, 1);
    this.renderAttachmentPreviews();
    this.updateSendButtonState();
  }

  clearAttachmentQueue() {
    for (const pa of this.pendingAttachments) {
      if (pa.url) URL.revokeObjectURL(pa.url);
    }
    this.pendingAttachments = [];
    this.renderAttachmentPreviews();
  }

  renderAttachmentPreviews() {
    this.attachPreview.innerHTML = '';
    if (!this.pendingAttachments.length) return;

    const wrap = document.createElement('div');
    wrap.className = 'attach-preview-wrap';

    this.pendingAttachments.forEach((pa, idx) => {
      const isImage = /^image\//.test(pa.file.type);

      const chip = document.createElement('div');
      chip.className = 'attach-chip';

      if (isImage) {
        const img = document.createElement('img');
        img.src = pa.url;
        img.alt = pa.file.name;
        img.loading = 'lazy';
        chip.appendChild(img);
      }

      const name = document.createElement('span');
      name.className = 'attach-name';
      name.textContent = pa.file.name || 'arquivo';
      chip.appendChild(name);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'attach-remove';
      removeBtn.type = 'button';
      removeBtn.title = 'Remover';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => this.removeQueuedAttachment(idx));
      chip.appendChild(removeBtn);

      wrap.appendChild(chip);
    });

    this.attachPreview.appendChild(wrap);
  }

  // ===== RENDERIZAÇÃO DE MENSAGENS =====
  addMessage(role, { text = '', audioUrl = null, attachments = [] } = {}) {
    const messageEl = document.createElement('div');
    messageEl.className = `message ${role}`;

    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';

    // Texto
    if (text && text.trim() !== '') {
      const textEl = document.createElement('div');
      textEl.textContent = text;
      contentEl.appendChild(textEl);
    }

    // Áudio
    if (audioUrl) {
      const audioWrapper = document.createElement('div');
      audioWrapper.style.display = 'flex';
      audioWrapper.style.flexDirection = 'column';
      audioWrapper.style.gap = '4px';

      const smallLabel = document.createElement('div');
      smallLabel.className = 'audio-label';
      smallLabel.textContent = role === 'user' ? '[Seu áudio]' : '[Áudio do suporte]';

      const audioPlayer = document.createElement('audio');
      audioPlayer.className = 'audio-player';
      audioPlayer.controls = true;
      audioPlayer.src = audioUrl;

      audioWrapper.appendChild(smallLabel);
      audioWrapper.appendChild(audioPlayer);
      contentEl.appendChild(audioWrapper);
    }

    // Anexos (render de mensagem enviada/recebida)
    if (attachments && attachments.length) {
      const wrap = document.createElement('div');
      wrap.className = 'attachments-wrap';

      attachments.forEach((file) => {
        const isImage = /^image\//.test(file.type);

        if (isImage) {
          const url = URL.createObjectURL(file);
          const fig = document.createElement('figure');
          fig.className = 'attachment-thumb';

          const img = document.createElement('img');
          img.src = url;
          img.alt = file.name || 'Imagem';
          img.loading = 'lazy';
          img.onclick = () => {
            // abre no modal existente
            const modal = document.getElementById('imageModal');
            const modalImg = document.getElementById('modalImg');
            if (modal && modalImg) {
              modalImg.src = url;
              modal.classList.add('active');
            }
          };

          const cap = document.createElement('figcaption');
          cap.textContent = file.name || 'Imagem';

          fig.appendChild(img);
          fig.appendChild(cap);
          wrap.appendChild(fig);
        } else {
          const chip = document.createElement('a');
          chip.className = 'attachment-chip';
          chip.textContent = file.name || 'arquivo';
          chip.href = URL.createObjectURL(file);
          chip.download = file.name || 'arquivo';
          wrap.appendChild(chip);
        }
      });

      contentEl.appendChild(wrap);
    }

    messageEl.appendChild(contentEl);
    this.messagesContainer.appendChild(messageEl);
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  // ===== UI =====
  showTypingIndicator() {
    const messageEl = document.createElement('div');
    messageEl.className = 'message assistant';
    messageEl.id = 'typingIndicator';

    const indicatorEl = document.createElement('div');
    indicatorEl.className = 'typing-indicator';
    indicatorEl.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';

    messageEl.appendChild(indicatorEl);
    this.messagesContainer.appendChild(messageEl);
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  removeTypingIndicator() {
    const typing = document.getElementById('typingIndicator');
    if (typing) typing.remove();
  }

  // ===== HISTÓRICO =====
  saveConversationHistory() {
    try {
      localStorage.setItem(
        'elton_ti_chat_history',
        JSON.stringify(this.conversationHistory)
      );
    } catch {
      console.log('Não foi possível salvar histórico');
    }
  }

  loadConversationHistory() {
    try {
      const saved = localStorage.getItem('elton_ti_chat_history');
      if (saved) {
        this.conversationHistory = JSON.parse(saved);
        console.log(
          '✅ Histórico carregado:',
          this.conversationHistory.length,
          'mensagens'
        );
      }
    } catch {
      console.log('Não foi possível carregar histórico');
    }
  }
}

// Inicializa
const chat = new ChatElton();
console.log('✅ Chat Elton Suporte TI carregado com suporte a Áudio e Anexos (compositor)!');

