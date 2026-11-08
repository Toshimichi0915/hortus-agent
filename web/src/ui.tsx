/**
 * The UI kit: the router and stores, and the app's own shapes of shadcn/ui's primitives (`components/ui/`): buttons with
 * an icon and a busy state, labelled form fields, dialogs, toasts, time formatting.
 */
import { cn } from "cn";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bell,
  Box,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Code,
  Compass,
  Copy,
  Cpu,
  Ellipsis,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  Folder,
  GitMerge,
  Globe,
  House,
  Inbox,
  Info,
  KeyRound,
  Link2,
  ListChecks,
  Lock,
  LogOut,
  type LucideIcon,
  MapPin,
  Menu,
  MessageCircle,
  Monitor,
  Moon,
  Network,
  PanelLeft,
  Pause,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Scale,
  Search,
  Send,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Sprout,
  Square,
  SquareTerminal,
  Sun,
  Trash2,
  TriangleAlert,
  Upload,
  User,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import {
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { toast as sonner } from "sonner";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { buttonVariants, Button as UiButton } from "@/components/ui/button";
import { CardAction, CardContent, CardDescription, CardHeader, CardTitle, Card as UiCard } from "@/components/ui/card";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Dialog as UiDialog,
} from "@/components/ui/dialog";
import {
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Empty as UiEmpty,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Toaster } from "@/components/ui/sonner";
import { Spinner as UiSpinner } from "@/components/ui/spinner";
import { Switch as UiSwitch } from "@/components/ui/switch";
import { TabsList, TabsTrigger, Tabs as UiTabs } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export { buttonVariants, cn };

// ---------------------------------------------------------------------------------------------------------------------
// Stores: one value, many readers (toasts, confirm, theme, the clock)

export interface Store<T> {
  get(): T;
  set(v: T): void;
  sub(f: () => void): () => void;
}

export function store<T>(init: T): Store<T> {
  let v = init;
  const fs = new Set<() => void>();
  return {
    get: () => v,
    set(n) {
      v = n;
      for (const f of fs) f();
    },
    sub(f) {
      fs.add(f);
      return () => fs.delete(f);
    },
  };
}

export const useStore = <T,>(s: Store<T>): T => useSyncExternalStore(s.sub, s.get);

// ---------------------------------------------------------------------------------------------------------------------
// Router: the History API, so the daemon's links (`/tasks/<id>`, `/approvals/<id>`) open the right page

const href = store(location.href);
window.addEventListener("popstate", () => href.set(location.href));

type Guard = (to: string) => boolean | Promise<boolean>;
let leaveGuard: Guard | null = null;
/** A page with unsaved changes sets this; `navigate` asks it (and waits for its answer) before leaving. */
export const setLeaveGuard = (g: Guard | null): void => {
  leaveGuard = g;
};

export function navigate(to: string, replace = false): void {
  const go = () => {
    history[replace ? "replaceState" : "pushState"](null, "", to);
    href.set(location.href);
  };
  const ok = leaveGuard?.(to) ?? true;
  if (ok === true) go();
  else if (ok !== false) ok.then((yes) => yes && go());
}

export function useLocation(): { path: string; query: URLSearchParams } {
  const u = new URL(useStore(href));
  return { path: u.pathname, query: u.searchParams };
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      {...rest}
      href={to}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || rest.target)
          return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Icons: lucide, by short name, so data (a task kind, a section) can say which

const ICONS = {
  plus: Plus,
  chat: MessageCircle,
  shield: ShieldCheck,
  tasks: ListChecks,
  clock: Clock,
  search: Search,
  settings: SlidersHorizontal,
  plug: Plug,
  folder: Folder,
  key: KeyRound,
  sidebar: PanelLeft,
  menu: Menu,
  arrowUp: ArrowUp,
  arrowDown: ArrowDown,
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,
  stop: Square,
  copy: Copy,
  check: Check,
  x: X,
  chevronRight: ChevronRight,
  chevronDown: ChevronDown,
  alert: TriangleAlert,
  info: Info,
  pause: Pause,
  play: Play,
  external: ExternalLink,
  more: Ellipsis,
  refresh: RefreshCw,
  trash: Trash2,
  edit: Pencil,
  eye: Eye,
  eyeOff: EyeOff,
  terminal: SquareTerminal,
  file: File,
  globe: Globe,
  lock: Lock,
  user: User,
  merge: GitMerge,
  sparkle: Sparkles,
  cpu: Cpu,
  network: Network,
  bell: Bell,
  compass: Compass,
  wrench: Wrench,
  box: Box,
  server: Server,
  phone: Smartphone,
  code: Code,
  link: Link2,
  upload: Upload,
  logout: LogOut,
  bolt: Zap,
  scale: Scale,
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
  home: House,
  inbox: Inbox,
  send: Send,
  pin: MapPin,
  calendar: Calendar,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  const I = ICONS[name];
  return <I size={size} strokeWidth={1.75} aria-hidden="true" className={cn("shrink-0", className)} />;
}

export const Logo = ({ size = 22 }: { size?: number }) => (
  <Sprout size={size} strokeWidth={2} aria-hidden="true" className="shrink-0 text-brand" />
);

export const Spinner = ({ size = 16 }: { size?: number }) => (
  <UiSpinner className="shrink-0" style={{ width: size, height: size }} />
);

// ---------------------------------------------------------------------------------------------------------------------
// Buttons

type Variant = "primary" | "secondary" | "ghost" | "danger" | "quiet-danger";

const VARIANT = {
  primary: "default",
  secondary: "outline",
  ghost: "ghost",
  danger: "destructive",
  "quiet-danger": "ghost",
} as const;

export function Button({
  variant = "secondary",
  size,
  icon,
  loading,
  children,
  className,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm" | "lg";
  icon?: IconName;
  loading?: boolean;
}) {
  const small = size === "sm";
  return (
    <UiButton
      type="button"
      {...rest}
      variant={VARIANT[variant]}
      size={children ? (size ?? "default") : small ? "icon-sm" : "icon"}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        variant === "quiet-danger" && "text-destructive hover:bg-destructive/10 hover:text-destructive",
        className,
      )}
    >
      {loading ? <Spinner size={small ? 14 : 16} /> : icon && <Icon name={icon} size={small ? 14 : 16} />}
      {children}
    </UiButton>
  );
}

/** An icon-only button: `label` is its accessible name and tooltip. */
export const IconButton = ({
  label,
  ...rest
}: Omit<Parameters<typeof Button>[0], "children" | "aria-label"> & { label: string; icon: IconName }) => (
  <Button variant="ghost" {...rest} aria-label={label} title={label} />
);

export function CopyButton({ text, label = "Copy", showLabel }: { text: string; label?: string; showLabel?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={done ? "check" : "copy"}
      aria-label={label}
      title={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast("Copying needs a secure page (HTTPS or localhost)", "error");
        }
      }}
    >
      {showLabel ? (done ? "Copied" : label) : null}
    </Button>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Toasts and the async action helper

export function toast(text: string, tone: "success" | "error" | "info" = "success"): void {
  sonner[tone](text, tone === "error" ? { duration: 9000 } : undefined);
}

export function Toasts() {
  const t = useStore(theme);
  return <Toaster theme={t} position="top-center" closeButton />;
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * `[run, busy]`: runs `fn`, toasts its error, and on success `done` (a string, or one made from the result; the
 * result's own `message`, as hortusd's RPCs give, when `done` is omitted).
 */
export function useAction<A extends unknown[], R>(
  fn: (...a: A) => Promise<R>,
  done?: string | ((r: R) => string | undefined),
): [(...a: A) => Promise<R | undefined>, boolean] {
  const [busy, setBusy] = useState(false);
  const run = async (...a: A) => {
    setBusy(true);
    try {
      const r = await fn(...a);
      const msg =
        typeof done === "function"
          ? done(r)
          : (done ?? (r && typeof r === "object" && "message" in r ? String(r.message) : undefined));
      if (msg) toast(msg);
      return r;
    } catch (e) {
      toast(errorText(e), "error");
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return [run, busy];
}

/** Newer and older pages of a list (api.ts › usePaged); nothing while both ends are in view. */
export function Pager({ page, more, onPage }: { page: number; more: boolean; onPage: (p: number) => void }) {
  if (!page && !more) return null;
  return (
    <nav className="flex items-center justify-end gap-2 text-[13px] text-muted-foreground" aria-label="Pages">
      <span className="mr-auto">Page {page + 1}</span>
      <Button size="sm" icon="arrowLeft" disabled={!page} onClick={() => onPage(page - 1)}>
        Newer
      </Button>
      <Button size="sm" disabled={!more} onClick={() => onPage(page + 1)}>
        Older <Icon name="arrowRight" size={14} />
      </Button>
    </nav>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Dialogs

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <UiDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className={cn("flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-lg", wide && "sm:max-w-3xl")}
        onOpenAutoFocus={(e) => {
          const first = (e.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-autofocus]");
          if (first) {
            e.preventDefault();
            first.focus();
          }
        }}
      >
        <DialogHeader className="px-5 pt-5 pr-12 pb-2">
          <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
          {description && (
            <DialogDescription asChild>
              <div>{description}</div>
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-2 pb-5">{children}</div>
        {footer && <DialogFooter className="mx-0 mb-0 px-5 py-3">{footer}</DialogFooter>}
      </DialogContent>
    </UiDialog>
  );
}

interface ConfirmOpts {
  title: string;
  body?: ReactNode;
  confirm?: string;
  danger?: boolean;
}

const confirming = store<(ConfirmOpts & { resolve: (ok: boolean) => void }) | null>(null);

/** Resolves true when the owner confirms. */
export const confirmAction = (o: ConfirmOpts): Promise<boolean> =>
  new Promise((resolve) => confirming.set({ ...o, resolve }));

export function ConfirmHost() {
  const c = useStore(confirming);
  const done = (ok: boolean) => {
    c?.resolve(ok);
    confirming.set(null);
  };
  return (
    <AlertDialog open={!!c} onOpenChange={(o) => !o && done(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{c?.title}</AlertDialogTitle>
          {c?.body && (
            <AlertDialogDescription asChild>
              <div>{c.body}</div>
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={c?.danger ? "destructive" : "default"} onClick={() => done(true)}>
            {c?.confirm ?? "Confirm"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Form controls. Each takes `label`, `hint`, `error`; the label is tied to the control by id.

interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  /** shown after the hint: "Default: 50" */
  def?: string;
  /** a badge: the value applies at hortusd's next start */
  restart?: boolean;
  /** shown when the value differs from the default */
  onReset?: (() => void) | undefined;
  optional?: boolean;
  className?: string;
}

const HINT = "text-[13px] leading-snug text-muted-foreground";
const LINK = "inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-brand-text hover:underline";

const FieldError = ({ id, children }: { id?: string; children: ReactNode }) => (
  <p className="flex items-start gap-1.5 text-[13px] text-destructive" id={id}>
    <Icon name="alert" size={14} className="mt-0.5" /> {children}
  </p>
);

function Top({
  p,
  htmlFor,
  id,
}: {
  p: Omit<FieldProps, "label"> & { label?: ReactNode };
  htmlFor?: string;
  id?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Label htmlFor={htmlFor} id={id}>
        {p.label}
        {p.optional && <span className="ml-1 text-[13px] font-normal text-muted-foreground">optional</span>}
      </Label>
      {p.restart && (
        <Badge variant="outline" className="text-muted-foreground" title="hortusd reads this when it starts">
          after restart
        </Badge>
      )}
      {p.onReset && (
        <button type="button" className={cn(LINK, "ml-auto text-xs")} onClick={p.onReset}>
          Reset to default
        </button>
      )}
    </div>
  );
}

function Shell({ id, children, ...p }: FieldProps & { id: string; children: ReactNode }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", p.className)}>
      <Top p={p} htmlFor={id} />
      {(p.hint || p.def) && (
        <p className={HINT} id={`${id}-hint`}>
          {p.hint}
          {p.def && <span> Default: {p.def}.</span>}
        </p>
      )}
      {children}
      {p.error && <FieldError id={`${id}-err`}>{p.error}</FieldError>}
    </div>
  );
}

const described = (id: string, p: FieldProps) =>
  cn(p.hint || p.def ? `${id}-hint` : undefined, p.error && `${id}-err`) || undefined;

export function TextField({
  value,
  onChange,
  placeholder,
  mono,
  type = "text",
  list,
  autoFocus,
  disabled,
  required,
  autoComplete,
  ...p
}: FieldProps & {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  type?: string;
  list?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  required?: boolean;
  autoComplete?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <Shell id={id} {...p}>
      <Input
        ref={ref}
        id={id}
        data-autofocus={autoFocus || undefined}
        className={cn(mono && "font-mono")}
        type={type}
        value={value}
        placeholder={placeholder}
        list={list}
        disabled={disabled}
        required={required}
        autoComplete={autoComplete ?? "off"}
        spellCheck={false}
        aria-invalid={!!p.error || undefined}
        aria-describedby={described(id, p)}
        onChange={(e) => onChange(e.target.value)}
      />
    </Shell>
  );
}

export function SecretField({
  value,
  onChange,
  placeholder,
  multiline,
  ...p
}: FieldProps & { value: string; onChange: (v: string) => void; placeholder?: string; multiline?: boolean }) {
  const id = useId();
  const [shown, setShown] = useState(false);
  return (
    <Shell id={id} {...p}>
      {multiline ? (
        <Textarea
          id={id}
          className={cn("font-mono", !shown && "[-webkit-text-security:disc]")}
          rows={5}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-describedby={described(id, p)}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <div className="relative">
          <Input
            id={id}
            className="pr-10 font-mono"
            type={shown ? "text" : "password"}
            value={value}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="new-password"
            aria-describedby={described(id, p)}
            onChange={(e) => onChange(e.target.value)}
          />
          <IconButton
            label={shown ? "Hide" : "Show"}
            icon={shown ? "eyeOff" : "eye"}
            size="sm"
            className="absolute top-1/2 right-1 -translate-y-1/2"
            onClick={() => setShown(!shown)}
          />
        </div>
      )}
      {multiline && (
        <div className="flex items-center gap-3">
          <button type="button" className={LINK} onClick={() => setShown(!shown)}>
            {shown ? "Hide" : "Show"}
          </button>
          <label className={cn(LINK, "relative cursor-pointer focus-within:underline")}>
            Load from a file…
            <input
              type="file"
              accept=".pem,.key,.txt,text/plain"
              className="absolute inset-0 w-full cursor-pointer opacity-0"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) onChange(await f.text());
              }}
            />
          </label>
        </div>
      )}
    </Shell>
  );
}

export function NumberField({
  value,
  onChange,
  min,
  max,
  step,
  unit,
  presets,
  ...p
}: FieldProps & {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  presets?: { label: string; value: number }[];
}) {
  const id = useId();
  // the text being typed, so an empty or half-typed field is not snapped back to a number
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
  }, [value, text]);
  return (
    <Shell id={id} {...p}>
      <div className="flex">
        <Input
          id={id}
          className={cn("tabular-nums", unit && "rounded-r-none")}
          type="number"
          inputMode="decimal"
          value={text}
          min={min}
          max={max}
          step={step}
          aria-invalid={!!p.error || undefined}
          aria-describedby={described(id, p)}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value !== "" && Number.isFinite(e.target.valueAsNumber)) onChange(e.target.valueAsNumber);
          }}
        />
        {unit && (
          <span className="flex items-center rounded-r-lg border border-l-0 border-input bg-muted px-3 text-[13px] whitespace-nowrap text-muted-foreground">
            {unit}
          </span>
        )}
      </div>
      {presets && (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((x) => (
            <button
              type="button"
              key={x.label}
              aria-pressed={x.value === value}
              className={cn(
                badgeVariants({ variant: "outline" }),
                "cursor-pointer text-muted-foreground hover:text-foreground",
                x.value === value && "border-brand bg-brand/10 text-brand-text",
              )}
              onClick={() => onChange(x.value)}
            >
              {x.label}
            </button>
          ))}
        </div>
      )}
    </Shell>
  );
}

export interface Option<T extends string = string> {
  value: T;
  label: ReactNode;
  hint?: ReactNode;
  icon?: IconName;
  disabled?: boolean;
}

const PICK_TRIGGER =
  "flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-input bg-transparent py-1 pr-2.5 pl-2.5 text-left text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive";

/** Radix keeps "" for "nothing picked", and our lists offer it as a choice ("No project", "Everywhere"). */
const EMPTY = "__empty__";

/** A short list to pick from, drawn as a combobox is: a native select's open list is the browser's own. */
export function Picker<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  className,
  id,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
}: {
  value: T;
  onChange: (v: T) => void;
  /** a run of options with one `group` is headed by it */
  options: { value: T; label: string; group?: string }[];
  /** shown while `value` is "" and no option is "" */
  placeholder?: string;
  className?: string;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string | undefined;
}) {
  const offersEmpty = options.some((o) => o.value === "");
  return (
    <Select
      value={value === "" && offersEmpty ? EMPTY : value}
      onValueChange={(v) => onChange((v === EMPTY ? "" : v) as T)}
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        className={cn(PICK_TRIGGER, "w-fit data-[placeholder]:text-muted-foreground", className)}
      >
        <SelectValue placeholder={placeholder}>
          {/* a value no option has, such as a removed messenger, still shows */}
          <span className="truncate">{options.find((o) => o.value === value)?.label ?? value}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent collisionPadding={8}>
        {[...new Set(options.map((o) => o.group))].map((group) => (
          <SelectGroup key={group ?? ""}>
            {group && <SelectLabel>{group}</SelectLabel>}
            {options
              .filter((o) => o.group === group)
              .map((o) => (
                <SelectItem key={o.value} value={o.value || EMPTY}>
                  {o.label}
                </SelectItem>
              ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * A list to search, by substring: a native select only jumps by a name's first letters. With `typed`, what was typed can
 * be used as it is, for a list that is never sure to be whole.
 */
export function ComboboxField({
  value,
  onChange,
  options,
  placeholder,
  typed: free,
  disabled,
  ...p
}: FieldProps & {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder: string;
  typed?: boolean;
  disabled?: boolean | undefined;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const typed = query.trim();
  const shown = options.filter((o) => o.label.toLowerCase().includes(typed.toLowerCase()));
  const current = options.find((o) => o.value === value)?.label ?? value;
  const pick = (v: string) => {
    onChange(v);
    setQuery("");
    setOpen(false);
  };
  return (
    <Shell id={id} {...p}>
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setQuery("");
        }}
      >
        <PopoverTrigger asChild>
          <button
            id={id}
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-invalid={!!p.error || undefined}
            aria-describedby={described(id, p)}
            disabled={disabled}
            className={PICK_TRIGGER}
          >
            <span className={cn("truncate", !current && "text-muted-foreground")}>{current || placeholder}</span>
            <Icon name="chevronDown" size={16} className="shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" collisionPadding={8} className="w-(--radix-popover-trigger-width) min-w-64 p-0">
          {/* our own filter: cmdk's fuzzy one matches scattered letters and reorders the list */}
          <Command shouldFilter={false}>
            <CommandInput placeholder="Search…" value={query} onValueChange={setQuery} />
            <CommandList>
              <CommandEmpty>{free ? "Nothing to pick yet: type a name." : "No match."}</CommandEmpty>
              {shown.map((o) => (
                <CommandItem key={o.value} value={`pick:${o.value}`} onSelect={() => pick(o.value)}>
                  <span className="truncate">{o.label}</span>
                </CommandItem>
              ))}
              {free && typed && !options.some((o) => o.value === typed) && (
                <CommandItem value={`use:${typed}`} onSelect={() => pick(typed)}>
                  <span className="truncate">Use "{typed}"</span>
                </CommandItem>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </Shell>
  );
}

export function SelectField<T extends string>({
  value,
  onChange,
  options,
  ...p
}: FieldProps & { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  const id = useId();
  return (
    <Shell id={id} {...p}>
      <Picker
        id={id}
        className="w-full"
        value={value}
        aria-describedby={described(id, p)}
        onChange={onChange}
        options={options}
      />
    </Shell>
  );
}

export function TextArea({
  value,
  onChange,
  rows = 4,
  placeholder,
  mono,
  ...p
}: FieldProps & { value: string; onChange: (v: string) => void; rows?: number; placeholder?: string; mono?: boolean }) {
  const id = useId();
  return (
    <Shell id={id} {...p}>
      <Textarea
        id={id}
        className={cn(mono && "font-mono")}
        rows={rows}
        value={value}
        placeholder={placeholder}
        aria-invalid={!!p.error || undefined}
        aria-describedby={described(id, p)}
        onChange={(e) => onChange(e.target.value)}
      />
    </Shell>
  );
}

/** Radix takes "" for "nothing chosen", and a choice here can be the empty string ("Model default"). */
const NONE = "__none";

/** One of a few: a segmented toggle group, or (`cards`) one radio card per option, for the choices that matter. */
export function Choice<T extends string>({
  value,
  onChange,
  options,
  cards,
  ...p
}: Omit<FieldProps, "label"> & {
  label?: ReactNode;
  value: T;
  onChange: (v: T) => void;
  options: Option<T>[];
  cards?: boolean;
  name?: string;
}) {
  const id = useId();
  const pick = (v: string) => {
    if (v) onChange((v === NONE ? "" : v) as T);
  };
  const group = cards ? (
    <RadioGroup
      value={value || NONE}
      onValueChange={pick}
      aria-labelledby={p.label ? `${id}-l` : undefined}
      className={cn(
        "grid gap-2.5",
        options.length === 4
          ? "grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))]"
          : "grid-cols-[repeat(auto-fit,minmax(min(100%,210px),1fr))]",
      )}
    >
      {options.map((o) => (
        <Label
          key={o.value}
          className={cn(
            "items-start gap-3 rounded-lg border border-input p-3.5 font-normal transition-colors select-auto",
            "cursor-pointer hover:border-brand/50 has-data-[state=checked]:border-brand has-data-[state=checked]:bg-brand/5",
            "has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
          )}
        >
          {o.icon && (
            <span className="grid size-8 flex-none place-items-center rounded-md bg-muted text-muted-foreground">
              <Icon name={o.icon} size={17} />
            </span>
          )}
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex items-center gap-2 text-sm leading-snug font-medium">{o.label}</span>
            {o.hint && <span className={HINT}>{o.hint}</span>}
          </span>
          <RadioGroupItem value={o.value || NONE} disabled={o.disabled} />
        </Label>
      ))}
    </RadioGroup>
  ) : (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={value || NONE}
      onValueChange={pick}
      aria-labelledby={p.label ? `${id}-l` : undefined}
      className="flex-wrap"
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.value}
          value={o.value || NONE}
          disabled={o.disabled}
          title={typeof o.hint === "string" ? o.hint : undefined}
          className="data-[state=on]:bg-foreground data-[state=on]:text-background"
        >
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
  if (!p.label) return group;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", p.className)}>
      <Top p={p} id={`${id}-l`} />
      {(p.hint || p.def) && (
        <p className={HINT}>
          {p.hint}
          {p.def && <span> Default: {p.def}.</span>}
        </p>
      )}
      {group}
      {p.error && <FieldError>{p.error}</FieldError>}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor={id}>{label}</Label>
        {hint && (
          <p className={HINT} id={`${id}-hint`}>
            {hint}
          </p>
        )}
      </div>
      <UiSwitch
        id={id}
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="data-[state=checked]:bg-brand"
        onCheckedChange={onChange}
      />
    </div>
  );
}

/**
 * A list of short values as removable badges plus an input: Enter or a comma adds, a pasted list splits on commas and
 * newlines. `check` refuses a value with its reason.
 */
export function ListInput({
  values,
  onChange,
  placeholder,
  check,
  mono = true,
  suggestions,
  ...p
}: FieldProps & {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  check?: (v: string) => string | undefined;
  mono?: boolean;
  suggestions?: string[];
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [bad, setBad] = useState<string>();
  const add = (raw: string) => {
    const items = raw
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const next = [...values];
    for (const v of items) {
      const why = check?.(v);
      if (why) {
        setBad(`${v}: ${why}`);
        setText(v);
        onChange(next);
        return;
      }
      if (!next.includes(v)) next.push(v);
    }
    setBad(undefined);
    setText("");
    onChange(next);
  };
  const error = bad ?? p.error;
  return (
    <Shell id={id} {...p} error={error}>
      <div
        data-invalid={!!error || undefined}
        className={cn(
          "flex min-h-8 flex-wrap items-center gap-1.5 rounded-lg border border-input bg-transparent p-1 dark:bg-input/30",
          "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 data-invalid:border-destructive",
          mono && "font-mono",
        )}
      >
        {values.map((v) => (
          <Badge key={v} variant="secondary" className="h-auto max-w-full gap-0.5 rounded-md pr-0.5 whitespace-normal">
            <span className="wrap-anywhere">{v}</span>
            <button
              type="button"
              aria-label={`Remove ${v}`}
              className="grid cursor-pointer rounded-sm p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              <Icon name="x" size={12} />
            </button>
          </Badge>
        ))}
        <input
          id={id}
          className="min-w-36 flex-1 bg-transparent px-1.5 py-0.5 text-sm outline-none placeholder:text-muted-foreground"
          value={text}
          placeholder={values.length ? "Add another…" : placeholder}
          list={suggestions ? `${id}-s` : undefined}
          spellCheck={false}
          autoComplete="off"
          aria-describedby={described(id, p)}
          onChange={(e) => {
            setBad(undefined);
            if (/[,\n]/.test(e.target.value)) add(e.target.value);
            else setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (text.trim()) add(text);
            } else if (e.key === "Backspace" && !text && values.length) onChange(values.slice(0, -1));
          }}
          onBlur={() => text.trim() && add(text)}
        />
        {suggestions && (
          <datalist id={`${id}-s`}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        )}
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Display

type Tone = "neutral" | "accent" | "ok" | "info" | "warning" | "danger";

const PILL: Record<Tone, string> = {
  neutral: "border-border bg-muted text-foreground/80",
  accent: "bg-brand/10 text-brand-text",
  info: "bg-brand/10 text-brand-text",
  ok: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  danger: "bg-destructive/10 text-destructive",
};

export const Pill = ({
  tone = "neutral",
  dot,
  pulse,
  children,
  title,
}: {
  tone?: Tone;
  dot?: boolean;
  pulse?: boolean;
  children: ReactNode;
  title?: string;
}) => (
  <Badge variant="outline" className={cn("border-transparent", PILL[tone])} title={title}>
    {dot && (
      <span
        className={cn("size-1.5 rounded-full bg-current", pulse && "motion-safe:animate-pulse")}
        aria-hidden="true"
      />
    )}
    {children}
  </Badge>
);

const CALLOUT = {
  info: "border-brand/25 bg-brand/5 *:[svg]:text-brand",
  ok: "border-success/25 bg-success/5 *:[svg]:text-success",
  warning: "border-warning/30 bg-warning/10 *:[svg]:text-warning",
  danger: "border-destructive/30 bg-destructive/5 *:[svg]:text-destructive",
};

export function Callout({
  tone = "info",
  title,
  children,
  action,
}: {
  tone?: "info" | "warning" | "danger" | "ok";
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Alert
      role={tone === "danger" ? "alert" : "status"}
      className={cn("wrap-anywhere has-data-[slot=alert-action]:pr-30", CALLOUT[tone])}
    >
      <Icon name={tone === "ok" ? "check" : tone === "info" ? "info" : "alert"} />
      {title && <AlertTitle>{title}</AlertTitle>}
      {children && <AlertDescription>{children}</AlertDescription>}
      {action && <AlertAction>{action}</AlertAction>}
    </Alert>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className,
  flush,
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** the content runs to the card's edges (lists, tabs) */
  flush?: boolean;
  id?: string;
}) {
  return (
    <UiCard className={cn(flush && "gap-0 py-0", className)} id={id}>
      {(title || actions) && (
        <CardHeader className={cn(flush && "pt-4")}>
          {title && (
            <CardTitle className="flex items-center gap-2 font-semibold [&_a]:text-inherit [&_a]:no-underline [&_a]:hover:underline">
              {title}
            </CardTitle>
          )}
          {description && <CardDescription>{description}</CardDescription>}
          {actions && <CardAction>{actions}</CardAction>}
        </CardHeader>
      )}
      <CardContent className={cn("flex flex-col gap-3", flush && "gap-0 px-0")}>{children}</CardContent>
    </UiCard>
  );
}

export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: IconName;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <UiEmpty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon name={icon} />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {children && <EmptyDescription>{children}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </UiEmpty>
  );
}

export function Meter({
  value,
  max,
  label,
  detail,
}: {
  value: number;
  max: number;
  label: ReactNode;
  detail?: ReactNode;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between gap-2 text-[13px]">
        <span>{label}</span>
        <span className="text-muted-foreground">{detail}</span>
      </div>
      <Progress
        value={pct}
        aria-label={typeof label === "string" ? label : undefined}
        className={cn(
          "*:data-[slot=progress-indicator]:bg-brand",
          pct >= 80 && "*:data-[slot=progress-indicator]:bg-warning",
          pct >= 100 && "*:data-[slot=progress-indicator]:bg-destructive",
        )}
      />
    </div>
  );
}

/** Messengers and forges: a tile with the service's initial in its colour. */
export const SERVICES: Record<string, { label: string; color: string; kind: "messenger" | "forge" }> = {
  slack: { label: "Slack", color: "#611f69", kind: "messenger" },
  discord: { label: "Discord", color: "#5865f2", kind: "messenger" },
  telegram: { label: "Telegram", color: "#229ed9", kind: "messenger" },
  github: { label: "GitHub", color: "#24292f", kind: "forge" },
  gitlab: { label: "GitLab", color: "#e24329", kind: "forge" },
  bitbucket: { label: "Bitbucket", color: "#0052cc", kind: "forge" },
  files: { label: "Files", color: "#6b7280", kind: "messenger" },
};

export const ServiceTile = ({ type, size = 32 }: { type: string; size?: number }) => (
  <span
    className="inline-grid flex-none place-items-center rounded-[28%] leading-none font-bold text-white"
    style={{
      background: SERVICES[type]?.color ?? "var(--muted-foreground)",
      width: size,
      height: size,
      fontSize: size * 0.45,
    }}
    aria-hidden="true"
  >
    {(SERVICES[type]?.label ?? type).slice(0, 1).toUpperCase()}
  </span>
);

export function useTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · hortus` : "hortus";
  }, [title]);
}

/** A page: its scroll area, a back link, the heading, actions, then the content. */
export function Page({
  title,
  description,
  actions,
  back,
  wide,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
  wide?: boolean;
  children: ReactNode;
}) {
  useTitle(title);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        className={cn("mx-auto flex flex-col gap-5 px-4 pt-5 pb-20 sm:px-8 sm:pt-9", wide ? "max-w-6xl" : "max-w-4xl")}
      >
        <header className="flex flex-col gap-2.5">
          {back && (
            <Link
              to={back.to}
              className="inline-flex w-fit items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
            >
              <Icon name="arrowLeft" size={16} /> {back.label}
            </Link>
          )}
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-[1_1_320px]">
              <h1 className="text-2xl font-semibold tracking-tight wrap-anywhere">{title}</h1>
              {description && <p className="mt-1.5 max-w-[70ch] text-muted-foreground">{description}</p>}
            </div>
            {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}

/** A settings section's heading. */
export const SectionHead = ({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) => (
  <header className="mb-1 flex flex-wrap items-start justify-between gap-4">
    <div className="flex-[1_1_340px]">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {description && <p className="mt-1.5 max-w-[70ch] text-muted-foreground">{description}</p>}
    </div>
    {action}
  </header>
);

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { value: T; label: string; count?: number }[];
  label: string;
}) {
  return (
    <UiTabs value={value} onValueChange={(v) => onChange(v as T)}>
      <TabsList variant="line" aria-label={label} className="h-10 w-full justify-start border-b px-1">
        {tabs.map((t) => (
          <TabsTrigger key={t.value} value={t.value} className="flex-none px-3">
            {t.label}
            {t.count !== undefined && t.count > 0 && (
              <Badge variant="secondary" className="h-4.5 min-w-4.5 px-1">
                {t.count}
              </Badge>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
    </UiTabs>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Time and numbers

/** Every reader re-renders on one shared 30-second tick. */
const clock = store(Date.now());
setInterval(() => clock.set(Date.now()), 30_000);
export const useNow = (): number => useStore(clock);

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31536000],
  ["month", 2592000],
  ["week", 604800],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

export function rel(iso: string, now = Date.now()): string {
  const s = (Date.parse(iso) - now) / 1000;
  if (Math.abs(s) < 45) return s < 0 ? "just now" : "in a moment";
  for (const [unit, n] of UNITS) if (Math.abs(s) >= n || unit === "minute") return rtf.format(Math.round(s / n), unit);
  return "";
}

const dtf = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
export const absTime = (iso: string, timeZone?: string): string =>
  timeZone
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(iso))
    : dtf.format(new Date(iso));

export function RelTime({ iso, empty = "—" }: { iso: string | null | undefined; empty?: string }) {
  useNow();
  if (!iso) return <span className="muted">{empty}</span>;
  return (
    <time dateTime={iso} title={absTime(iso)}>
      {rel(iso)}
    </time>
  );
}

export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/** Dollars: `$20` for a whole limit, cents for what was spent, and what rounds to nothing does not read as free. */
export function fmtUsd(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

export const fmtNum = (n: number): string => n.toLocaleString();

// ---------------------------------------------------------------------------------------------------------------------
// Theme: system, light or dark; a per-browser choice. shadcn's dark styles hang off `.dark` on <html>.

export type Theme = "system" | "light" | "dark";

const readTheme = (): Theme => {
  try {
    const t = localStorage.getItem("hortus.theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
};

export const theme = store<Theme>(readTheme());
const systemDark = matchMedia("(prefers-color-scheme: dark)");
export const isDark = (t: Theme): boolean => t === "dark" || (t === "system" && systemDark.matches);
const applyTheme = () => {
  document.documentElement.classList.toggle("dark", isDark(theme.get()));
  try {
    localStorage.setItem("hortus.theme", theme.get());
  } catch {}
};
applyTheme();
theme.sub(applyTheme);
systemDark.addEventListener("change", applyTheme);
