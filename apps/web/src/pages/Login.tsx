import { useState, type FormEvent } from 'react';
import { USER_COLORS } from '@ensemble/shared';
import { Avatar } from '../messenger/Avatar';
import { navigate } from '../router';
import { useSession } from '../store/session';

const QUICK = [
  { name: 'Alice', color: USER_COLORS.coral },
  { name: 'Bob', color: USER_COLORS.sky },
];

export function Login() {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const error = useSession((s) => s.error);

  async function go(n: string) {
    setBusy(true);
    const ok = await useSession.getState().login(n);
    setBusy(false);
    if (ok) navigate('/', true);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void go(name);
  }

  return (
    <main className="flex h-full items-center justify-center">
      <div className="w-[380px] rounded-2xl border border-line bg-panel surface-sheet p-8">
        <h1 className="text-2xl font-semibold">Ensemble Room</h1>
        <p className="mt-2 text-sm text-muted">이름을 골라 입장하세요. 두 탭에서 서로 다른 사용자로 로그인할 수 있습니다.</p>

        <div className="mt-6 grid grid-cols-2 gap-3">
          {QUICK.map((q) => (
            <button
              key={q.name}
              type="button"
              disabled={busy}
              onClick={() => void go(q.name)}
              className="flex items-center justify-center gap-2.5 rounded-xl border px-4 py-3 text-base font-medium transition hover:brightness-95 disabled:opacity-50"
              style={{ borderColor: q.color, background: `${q.color}22` }}
            >
              <Avatar name={q.name} color={q.color} size={32} />
              {q.name}
            </button>
          ))}
        </div>

        <form onSubmit={onSubmit} className="mt-6 flex gap-2">
          <label htmlFor="login-name" className="sr-only">
            사용자 이름
          </label>
          {name.trim() && <Avatar name={name.trim()} color={USER_COLORS.coral} size={36} />}
          <input
            id="login-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="직접 입력"
            autoComplete="off"
            className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-sm placeholder:text-muted"
          />
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="rounded-lg border border-line bg-raised px-4 py-2 text-sm disabled:opacity-50"
          >
            입장
          </button>
        </form>

        {error && (
          <p role="alert" className="mt-4 text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
