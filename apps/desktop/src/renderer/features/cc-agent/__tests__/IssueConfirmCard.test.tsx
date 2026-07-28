// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IssueConfirmCard } from '../IssueConfirmCard';
import type { PendingIssueConfirm } from '@/lib/makerChatStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));

const initialPending: PendingIssueConfirm = {
  requestId: 'issue-request-a',
  draft: {
    title: '原始标题',
    body: '原始正文',
    type: 'bug',
  },
  env: {
    appVersion: '0.1.18',
    platform: 'win32',
    arch: 'x64',
    osVersion: '10.0',
  },
  submissionIdentity: {
    kind: 'github-user',
    login: 'tester',
  },
};

function Harness() {
  const [pending, setPending] = useState(initialPending);
  const [visible, setVisible] = useState(true);

  return (
    <>
      <button type="button" onClick={() => setVisible((current) => !current)}>
        switch session
      </button>
      {visible ? (
        <IssueConfirmCard
          pending={pending}
          onDraftChange={(requestId, patch) =>
            setPending((current) =>
              current.requestId === requestId
                ? {
                    ...current,
                    draft: { ...current.draft, ...patch },
                  }
                : current,
            )
          }
          onRespond={vi.fn()}
        />
      ) : null}
    </>
  );
}

afterEach(cleanup);

describe('IssueConfirmCard draft persistence', () => {
  it('restores title, body and type after a session-switch remount', () => {
    render(<Harness />);

    fireEvent.change(screen.getByLabelText('issueAgent.confirm.titleLabel'), {
      target: { value: '编辑后的标题' },
    });
    fireEvent.change(screen.getByLabelText('issueAgent.confirm.bodyLabel'), {
      target: { value: '编辑后的正文' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'issueAgent.confirm.typeFeature' }));

    fireEvent.click(screen.getByRole('button', { name: 'switch session' }));
    expect(screen.queryByLabelText('issueAgent.confirm.titleLabel')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'switch session' }));
    expect((screen.getByLabelText('issueAgent.confirm.titleLabel') as HTMLInputElement).value).toBe(
      '编辑后的标题',
    );
    expect(
      (screen.getByLabelText('issueAgent.confirm.bodyLabel') as HTMLTextAreaElement).value,
    ).toBe('编辑后的正文');
    expect(
      screen
        .getByRole('button', { name: 'issueAgent.confirm.typeFeature' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });
});
