import type { AgorClient, Branch, Repo, Session, User } from '@agor-live/client';
import { sessionPath } from '@agor-live/client';
import { Alert, Button, Card, Space, Spin, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

const { Title, Text, Paragraph } = Typography;

const PROMPT_PREVIEW_LEN = 300;

function decodePrompt(encoded: string): string {
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return decodeURIComponent(encoded);
  }
}

export interface NewSessionPageProps {
  client: AgorClient | null;
  currentUser?: User | null;
  onLogout?: () => void;
}

export function NewSessionPage({ client, currentUser }: NewSessionPageProps) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const repoId = searchParams.get('repoId') ?? '';
  const branchName = searchParams.get('branchName') ?? '';
  const ref = searchParams.get('ref') ?? 'HEAD';
  const boardId = searchParams.get('boardId') ?? undefined;
  const promptEncoded = searchParams.get('prompt') ?? '';
  const agent = searchParams.get('agent') ?? 'claude-code';

  const prompt = promptEncoded ? decodePrompt(promptEncoded) : '';

  const [repo, setRepo] = useState<Repo | null>(null);
  const [repoLoading, setRepoLoading] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const missingParams = !repoId || !branchName;

  useEffect(() => {
    if (!client || !repoId) return;
    setRepoLoading(true);
    setRepoError(null);
    client
      .service('repos')
      .get(repoId)
      .then((r) => setRepo(r as Repo))
      .catch((err: unknown) => {
        setRepoError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setRepoLoading(false));
  }, [client, repoId]);

  const handleConfirm = useCallback(async () => {
    if (!client || !currentUser) return;
    setCreating(true);
    setCreateError(null);
    try {
      const branch = (await client.service(`repos/${repoId}/branches`).create({
        name: branchName,
        sourceBranch: ref,
        createBranch: true,
        pullLatest: false,
        ...(boardId ? { boardId } : {}),
      })) as Branch;

      const session = (await client.service('sessions').create({
        branch_id: branch.branch_id,
        agent,
        title: branchName,
      })) as Session;

      await client.sessions.initialize(session.session_id, {
        expectedUserId: currentUser.user_id,
        prompt: prompt || undefined,
      });

      navigate(sessionPath(session.session_id));
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  }, [client, currentUser, repoId, branchName, ref, boardId, agent, prompt, navigate]);

  const containerStyle: React.CSSProperties = {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  };

  const cardStyle: React.CSSProperties = { maxWidth: 600, width: '100%' };

  if (!client || !currentUser) {
    return (
      <div style={containerStyle}>
        <Card style={cardStyle}>
          <Alert
            type="warning"
            message="Sign in to continue"
            description="You must be signed in to create a session."
          />
        </Card>
      </div>
    );
  }

  if (missingParams) {
    return (
      <div style={containerStyle}>
        <Card style={cardStyle}>
          <Alert
            type="error"
            message="Missing required parameters"
            description="Both repoId and branchName query parameters are required."
          />
        </Card>
      </div>
    );
  }

  const promptPreview =
    prompt.length > PROMPT_PREVIEW_LEN
      ? `${prompt.slice(0, PROMPT_PREVIEW_LEN)}… (${prompt.length.toLocaleString()} chars total)`
      : prompt;

  return (
    <div style={containerStyle}>
      <Card style={cardStyle}>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <Title level={4} style={{ margin: 0 }}>
            Start a new session
          </Title>

          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <Text strong>Branch</Text>
            <Text code>{branchName}</Text>
          </Space>

          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <Text strong>Repository</Text>
            {repoLoading ? (
              <Spin size="small" />
            ) : repoError ? (
              <Text type="danger">{repoError}</Text>
            ) : (
              <Text>{repo ? (repo.name ?? repoId) : repoId}</Text>
            )}
          </Space>

          {prompt && (
            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              <Text strong>Prompt</Text>
              <Paragraph
                style={{
                  // biome-ignore lint/plugin/noHardcodedColorLiteral: neutral tint for prompt preview code block
                  background: 'rgba(0,0,0,0.04)',
                  borderRadius: 6,
                  padding: '8px 12px',
                  fontFamily: 'monospace',
                  fontSize: 13,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 180,
                  overflow: 'hidden',
                  margin: 0,
                }}
              >
                {promptPreview}
              </Paragraph>
            </Space>
          )}

          {createError && (
            <Alert
              type="error"
              message="Failed to create session"
              description={createError}
              showIcon
            />
          )}

          <Space>
            <Button
              type="primary"
              onClick={handleConfirm}
              loading={creating}
              disabled={repoLoading}
            >
              {createError ? 'Retry' : 'Start session'}
            </Button>
            <Button onClick={() => navigate('/')} disabled={creating}>
              Cancel
            </Button>
          </Space>
        </Space>
      </Card>
    </div>
  );
}
