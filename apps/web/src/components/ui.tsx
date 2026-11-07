import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X, Inbox, Copy, AlertCircle, LoaderCircle } from "lucide-react";
import { errorText } from "../api";

export type Guard = {
  dirty: (value: boolean) => void;
  protect: (action: () => void) => void;
};
export type Notify = (message: string) => void;
export function Button({
  children,
  primary = false,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={`btn ${primary ? "primary" : ""} ${className}`}
    >
      {children}
    </button>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Inbox size={24} />
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
export function ErrorNotice({ error }: { error: string }) {
  return error ? (
    <div className="notice error" role="alert">
      <AlertCircle size={16} />
      <span>{error}</span>
    </div>
  ) : null;
}
export function Busy({ children = "正在读取…" }: { children?: ReactNode }) {
  return (
    <div className="loading">
      <LoaderCircle size={19} className="spin" />
      {children}
    </div>
  );
}
export function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`field ${className}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const items = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
        ) || [],
      );
    items()[0]?.focus();
    const handle = (e: KeyboardEvent) => {
      if (
        Array.from(document.querySelectorAll("[role=dialog]")).at(-1) !==
        ref.current
      )
        return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      }
      if (e.key === "Tab") {
        const list = items();
        const first = list[0];
        const last = list.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handle);
    return () => {
      document.removeEventListener("keydown", handle);
      previous?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop">
      <div
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        ref={ref}
      >
        <div className="modal-heading">
          <h2 id={id}>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={19} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function CopyButton({
  body,
  notify,
  label = "复制正文",
  prepare,
}: {
  body: string;
  notify: Notify;
  label?: string;
  prepare?: () => Promise<string>;
}) {
  const [manual, setManual] = useState(false);
  const [error, setError] = useState("");
  const [verifiedBody, setVerifiedBody] = useState("");
  const copy = async () => {
    let content = body;
    if (prepare) {
      try { content = await prepare(); }
      catch (e) { setManual(false); notify(errorText(e)); return; }
    }
    setVerifiedBody(content);
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("当前浏览器未提供剪贴板权限");
      await navigator.clipboard.writeText(content);
      notify("正文已复制");
      setManual(false);
    } catch (e) {
      setError(`复制未完成：${errorText(e)}。请在下方手工复制。`);
      setManual(true);
    }
  };
  return (
    <>
      <Button onClick={copy} disabled={!body}>
        <Copy size={14} />
        {label}
      </Button>
      {manual && (
        <Modal title="手工复制" onClose={() => setManual(false)}>
          <p className="muted">{error}</p>
          <textarea
            className="input copy-body"
            aria-label="手工复制正文"
            value={verifiedBody}
            readOnly
            onFocus={(e) => e.currentTarget.select()}
          />
        </Modal>
      )}
    </>
  );
}
export function PageHeading({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="page-subtitle">{description}</p>
      </div>
      <div className="heading-actions">{children}</div>
    </header>
  );
}
export function Section({
  title,
  children,
  action,
  className = "",
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="section-heading">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
