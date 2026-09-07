import { Dialog } from "@base-ui/react/dialog";
import { Button as BaseButton } from "@base-ui/react/button";
import { X, LoaderCircle } from "lucide-react";
import {
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

export function Button({
  className = "",
  variant = "secondary",
  ...props
}: ComponentProps<typeof BaseButton> & {
  variant?: "primary" | "secondary" | "ghost" | "icon";
}) {
  return (
    <BaseButton className={`btn btn-${variant} ${className}`} {...props} />
  );
}

export function Spinner({ label = "正在处理" }: { label?: string }) {
  return (
    <LoaderCircle
      aria-label={label}
      className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
    />
  );
}

export function Sheet({
  open,
  close,
  title,
  children,
  returnFocus,
  wide = false,
  action,
}: {
  open: boolean;
  close: () => void;
  title: string;
  children: ReactNode;
  returnFocus?: HTMLElement | null;
  wide?: boolean;
  action?: ReactNode;
}) {
  const [mobile, setMobile] = useState(
    () => matchMedia("(max-width: 767px)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(max-width: 767px)");
    const change = () => setMobile(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
      modal={mobile}
    >
      <Dialog.Portal>
        {mobile && <Dialog.Backdrop className="fixed inset-0 z-30 bg-ink/15" />}
        <Dialog.Popup
          className={`sheet ${wide ? "md:w-[400px]" : "md:w-[360px]"}`}
          initialFocus={(type) =>
            type === "touch"
              ? false
              : (document.querySelector<HTMLElement>("[data-panel-input]") ??
                true)
          }
          finalFocus={() => (returnFocus?.isConnected ? returnFocus : false)}
          aria-describedby={undefined}
        >
          <div className="flex h-16 shrink-0 items-center justify-between border-b border-line px-5">
            <Dialog.Title className="text-[15px] font-semibold">
              {title}
            </Dialog.Title>
            <div className="flex gap-1">
              {action}
              <Dialog.Close
                className="btn btn-icon"
                aria-label={`关闭${title}`}
              >
                <X className="size-[18px]" />
              </Dialog.Close>
            </div>
          </div>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ErrorMessage({ message }: { message: string }) {
  return message ? (
    <p
      role="alert"
      className="rounded-md bg-danger/5 px-3 py-2 text-sm leading-6 text-danger"
    >
      {message}
    </p>
  ) : null;
}
