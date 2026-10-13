'use client';
import { useState } from 'react';
import { Mail } from 'lucide-react';
import type { Shiur } from '@/lib/yutorah';
import { feedbackLink, type FeedbackKind } from '@/lib/feedback';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
export function FeedbackDialog({
  open,
  onOpenChange,
  shiur,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shiur?: Shiur;
}) {
  const [kind, setKind] = useState<FeedbackKind>(
      shiur ? 'content' : 'interface',
    ),
    [message, setMessage] = useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="feedback-dialog">
        <DialogHeader>
          <DialogTitle>{shiur ? 'Report this shiur' : 'Feedback'}</DialogTitle>
          <DialogDescription>
            {shiur
              ? shiur.title
              : 'Share a suggestion, question, or problem with the library.'}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!message.trim()) return;
            window.location.href = feedbackLink(
              kind,
              message,
              window.location.href,
              shiur,
            );
          }}
        >
          <label>
            <span>What would you like to share?</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as FeedbackKind)}
            >
              <option value="interface">An interface problem</option>
              <option value="content">An error in YUTorah content</option>
              <option value="suggestion">A feature suggestion</option>
              <option value="question">A question</option>
              <option value="comment">A comment</option>
            </select>
          </label>
          <label>
            <span>Details</span>
            <textarea
              required
              minLength={3}
              maxLength={3000}
              rows={5}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Describe what happened or what should be corrected…"
            />
          </label>
          <p>
            {kind === 'content'
              ? 'Content reports go to YUTorah at errors@yutorah.org.'
              : 'App feedback goes to yutorahv2@gmail.com.'}{' '}
            {shiur
              ? 'The shiur ID and original link are included.'
              : 'The current page link is included.'}
          </p>
          <button className="primary-button" type="submit">
            <Mail size={16} /> Open email draft
          </button>
          <small>You review and send the message in your email app.</small>
        </form>
      </DialogContent>
    </Dialog>
  );
}
