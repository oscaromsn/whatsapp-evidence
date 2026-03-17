// =============================================================================
// WhatsApp Screenshot Message Extraction
// For legal documentation - accuracy is paramount
// =============================================================================

// Media type classification for WhatsApp messages
enum MediaType {
  Text @description("Regular text message without media")
  Image @description("Photo or image attachment")
  Video @description("Video attachment")
  VoiceMessage @description("Voice/audio message (PTT - push to talk)")
  Document @description("Document file attachment (PDF, DOC, etc.)")
  Sticker @description("Sticker or figurinha")
  Gif @description("Animated GIF")
  Contact @description("Shared contact card")
  Location @description("Shared location or live location")
  LinkPreview @description("Message containing a link with preview")
  Deleted @description("Deleted message placeholder - 'Esta mensagem foi apagada'")
  Poll @description("Poll or enquete")
}

// Message delivery status (for sent messages)
enum MessageStatus {
  Sent @description("Single gray check - message sent to server")
  Delivered @description("Double gray checks - message delivered to recipient")
  Read @description("Double blue checks - message read by recipient")
  Pending @description("Clock icon - message pending/sending")
  Unknown @description("Status not visible or unclear in screenshot")
}

class WhatsAppMessage {
  // Date and time
  date string @description("Date in DD/MM/YYYY format")
  date_inferred bool @description("True if date was calculated from 'HOJE'/'ONTEM' using screenshot filename date")
  time string @description("Time in HH:MM format as shown next to message")

  // Sender identification
  sender string @description("Sender name, phone number, or 'Eu' for sent messages")

  // Message content
  content string @description("Complete message text including emojis, preserving original formatting and typos")
  media_type MediaType @description("Type of message content")
  media_description string? @description("For media: describe visible content, filename if shown, duration for audio, size for documents")

  // Reply context
  is_reply bool @description("True if message is replying to another message (shows quoted message above)")
  reply_preview string? @description("Content/preview of the replied-to message if visible")

  // Message metadata
  is_forwarded bool @description("True if message shows 'Encaminhada' or forwarded indicator")
  is_edited bool @description("True if message shows 'Editada' indicator")
  message_status MessageStatus? @description("Delivery status checkmarks for sent messages only")
}

class WhatsAppScreenshot {
  // Chat identification
  chat_name string @description("Contact or group name shown at top of chat header")
  chat_type string @description("'individual' for 1:1 conversation or 'group' for group chat")

  // Messages
  messages WhatsAppMessage[] @description("All visible messages in chronological order top to bottom")

  // Context and metadata
  visible_date_separators string[] @description("All date separator texts visible in screenshot (e.g., 'HOJE', 'ONTEM', '22/12/2024')")
  screenshot_context string? @description("Any system messages, encryption notices, 'mensagens temporárias', or other context")
  participant_count int? @description("For groups: number of participants if visible in header")
}

function ExtractWhatsAppMessages(screenshot: image, screenshot_filename: string) -> WhatsAppScreenshot {
  // Using openai provider (chat completion API) instead of openai-responses for vision support
  client CustomGPT5Chat
  prompt #"
    Você é um especialista forense em análise de capturas de tela do WhatsApp.
    Este documento será usado como evidência em um processo judicial.
    A PRECISÃO ABSOLUTA é fundamental - não assuma, não interprete, apenas registre.

    NOME DO ARQUIVO: {{ screenshot_filename }}
    Este nome pode seguir diferentes padrões:
    - IMG-YYYYMMDD-WA####.jpg (ex: IMG-20241219-WA0042.jpg)
    - PHOTO-YYYY-MM-DD-HH-MM-SS.jpg (ex: PHOTO-2025-12-19-01-45-08.jpg)
    - WhatsApp Image YYYY-MM-DD at HH.MM.SS.jpeg (ex: WhatsApp Image 2026-01-07 at 14.38.38.jpeg)
    Use a data do nome do arquivo para calcular datas relativas.

    ═══════════════════════════════════════════════════════════════════════════
    INSTRUÇÕES DETALHADAS
    ═══════════════════════════════════════════════════════════════════════════

    1. EXTRAÇÃO DE DATA
       ─────────────────
       • Procure separadores de data no chat (barras horizontais com texto)
       • Formatos explícitos: "22/12/2024", "22 de dezembro de 2024"
       • Formatos relativos que REQUEREM INFERÊNCIA:
         - "HOJE" → use a data do nome do arquivo → date_inferred=true
         - "ONTEM" → dia anterior à data do arquivo → date_inferred=true
       • Se não houver separador visível, use a última data conhecida → date_inferred=true
       • Registre TODOS os separadores de data em visible_date_separators

    2. IDENTIFICAÇÃO DO REMETENTE
       ──────────────────────────
       • Conversas individuais:
         - Balões à DIREITA (verde/azul): sender="Eu"
         - Balões à ESQUERDA (branco/cinza): use o nome do contato do cabeçalho
       • Grupos:
         - Identifique pelo nome/número colorido ACIMA de cada mensagem
         - Mensagens próprias ainda são "Eu"
       • chat_type: "individual" ou "group"

    3. TIPO DE MÍDIA (media_type)
       ─────────────────────────
       • text: mensagem de texto sem anexos
       • image: foto (miniatura visível ou ícone de câmera)
       • video: vídeo (ícone de play sobre miniatura)
       • voice_message: áudio/PTT (forma de onda sonora, duração em segundos)
       • document: arquivo (ícone de documento, geralmente mostra nome e tamanho)
       • sticker: figurinha
       • gif: GIF animado
       • contact: cartão de contato compartilhado
       • location: localização (mostra mapa)
       • link_preview: link com preview (mostra título/imagem do site)
       • deleted: "Esta mensagem foi apagada" ou "Você apagou esta mensagem"
       • poll: enquete

    4. DESCRIÇÃO DE MÍDIA (media_description)
       ─────────────────────────────────────
       Quando media_type NÃO for "text", descreva:
       • O que é visível na miniatura/preview
       • Nome do arquivo se mostrado (ex: "Contrato_2024.pdf")
       • Tamanho se mostrado (ex: "2,5 MB")
       • Duração para áudios (ex: "0:45")
       • Para imagens: descreva brevemente o conteúdo visível
       • Para documentos: tipo, nome, páginas se visível

    5. CONTEXTO DE RESPOSTA
       ────────────────────
       • is_reply=true quando há uma caixa de citação acima da mensagem
       • reply_preview: transcreva o conteúdo da mensagem citada

    6. INDICADORES DE MENSAGEM
       ───────────────────────
       • is_forwarded: procure por "Encaminhada" ou ícone de seta
       • is_edited: procure por "Editada" ao lado do horário
       • message_status (apenas para mensagens enviadas/"Eu"):
         - pending: ícone de relógio
         - sent: ✓ (um check cinza)
         - delivered: ✓✓ (dois checks cinza)
         - read: ✓✓ (dois checks azuis)

    7. TRANSCRIÇÃO DO CONTEÚDO
       ───────────────────────
       • Transcreva EXATAMENTE como aparece
       • Preserve erros de digitação, abreviações, gírias
       • Mantenha emojis, quebras de linha, formatação
       • NÃO corrija, NÃO interprete, NÃO resuma

    ═══════════════════════════════════════════════════════════════════════════

    {{ screenshot }}

    {{ ctx.output_format }}
  "#
}
