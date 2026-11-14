// Prompt builders for the local-AI features. These are ported from the
// desktop app's Rust commands (llm_explain, llm_word_examples, llm_chat_reply)
// so both apps ask the model the same questions.

import type { ChatMessage } from './llm';

const flat = (s: string) => s.trim().split(/\s+/).filter(Boolean).join(' ');

export function explainMessages(word: string, sentence: string): ChatMessage[] {
  const w = flat(word);
  const s = flat(sentence);
  const content = s
    ? `In the sentence below, explain what '${w}' means as it is used here. Give the ` +
      `specific sense in 1-2 plain sentences. If it is an idiom, figure of speech, or technical term, ` +
      `say so and give the plain meaning. Be concise and do not repeat the sentence back. ` +
      `Sentence: ${s}`
    : `Explain the word or phrase '${w}' concisely for a reader. Give its meaning in ` +
      `1-2 plain sentences, then one short example of use. Do not repeat this instruction.`;
  return [{ role: 'user', content }];
}

export function examplesMessages(word: string, sentence: string): ChatMessage[] {
  const w = flat(word);
  const s = flat(sentence);
  const avoid = s ? ` Don't reuse the reader's own sentence: "${s}".` : '';
  return [{
    role: 'user',
    content:
      `Give 3 short example sentences that each use the word or phrase '${w}' in a ` +
      `different context or sense than the others, to help a reader learn how it's used. Number them ` +
      `1-3, one sentence per line, with no extra commentary before or after.${avoid}`,
  }];
}

export interface ChatTurn { role: 'user' | 'assistant'; content: string; }

const PASSAGE_WORD_CAP = 2200;

export function chatMessages(passage: string, history: ChatTurn[], question: string): ChatMessage[] {
  const passageCapped = flat(passage).split(' ').slice(0, PASSAGE_WORD_CAP).join(' ');
  let convo = '';
  for (const turn of history) {
    const text = flat(turn.content);
    if (!text) continue;
    convo += `${turn.role === 'assistant' ? 'Assistant' : 'Reader'}: ${text} `;
  }
  return [{
    role: 'user',
    content:
      `You are helping a reader understand a passage from a book they're currently on. ` +
      `Answer using only the passage and the conversation below; if the answer isn't in the passage, ` +
      `say so briefly. Be concise.\n\nPassage: ${passageCapped}\n\n${convo}Reader: ${flat(question)}\nAssistant:`,
  }];
}
