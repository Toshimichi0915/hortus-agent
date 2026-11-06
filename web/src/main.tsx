/** The console's shell: the sidebar (new chat, pages, recent chats, settings, pause), the routes, toasts. */
import { Component, type ReactNode, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Label } from "@/components/ui/label";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";
import { TooltipProvider } from "@/components/ui/tooltip";
import { call, type Task, useCall } from "./api.ts";
import "./index.css";
import { ApprovalPage, Approvals, LoginView } from "./pages/approvals.tsx";
import { Conversation, Home } from "./pages/chat.tsx";
import { Enroll, SignIn } from "./pages/remote.tsx";
import { Schedules } from "./pages/schedules.tsx";
import { DofFileView, Search } from "./pages/search.tsx";
import { Settings } from "./pages/settings.tsx";
import { TaskPage, Tasks } from "./pages/tasks.tsx";
import {
  Button,
  buttonVariants,
  Callout,
  ConfirmHost,
  cn,
  confirmAction,
  Empty,
  errorText,
  Icon,
  type IconName,
  isDark,
  Link,
  Logo,
  navigate,
  Page,
  Toasts,
  theme,
  useAction,
  useLocation,
  useStore,
} from "./ui.tsx";

/** The old console's addresses, and the bare section roots */
const MOVED: Record<string, string> = {
  "/chat": "/",
  "/settings": "/settings/general",
  "/sources": "/settings/sources",
  "/projects": "/settings/projects",
  "/credentials": "/settings/credentials",
};

const dec = (s = "") => decodeURIComponent(s);

const ROUTES: [RegExp, (m: string[]) => ReactNode][] = [
  [/^\/$/, () => <Home />],
  [/^\/chat\/([^/]+)$/, ([, id = ""]) => <Conversation key={id} id={id} />],
  [/^\/approvals$/, () => <Approvals />],
  [/^\/approvals\/(\d+)$/, ([, id]) => <ApprovalPage key={id} id={Number(id)} />],
  [/^\/approvals\/(\d+)\/login$/, ([, id]) => <LoginView key={id} id={Number(id)} />],
  [/^\/tasks$/, () => <Tasks />],
  [/^\/tasks\/([^/]+)$/, ([, id = ""]) => <TaskPage key={id} id={id} />],
  [/^\/schedules$/, () => <Schedules />],
  [/^\/search$/, () => <Search />],
  [
    /^\/dof\/([^/]+)\/(.+)$/,
    ([, dof, p = ""]) => <DofFileView dof={dec(dof)} path={p.split("/").map(dec).join("/")} />,
  ],
  [/^\/settings\/([\w-]+)$/, ([, s = ""]) => <Settings section={s} />],
];

/** A page that throws says why; the shell stays up. */
class PageGuard extends Component<{ children: ReactNode }, { error?: unknown }> {
  override state: { error?: unknown } = {};
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override render() {
    if (this.state.error === undefined) return this.props.children;
    return (
      <Page title="This page could not be shown">
        <Callout tone="danger">{errorText(this.state.error)}</Callout>
      </Page>
    );
  }
}

function Route({ path }: { path: string }) {
  const moved = MOVED[path];
  useEffect(() => {
    if (moved) navigate(moved, true);
  }, [moved]);
  if (moved) return null;
  for (const [re, page] of ROUTES) {
    const m = re.exec(path);
    if (m) return page([...m]);
  }
  return (
    <Page title="Not found">
      <Empty
        icon="search"
        title="There is no page here"
        action={
          <Link to="/" className={buttonVariants()}>
            Go to a new chat
          </Link>
        }
      >
        Check the address, or pick a page from the sidebar.
      </Empty>
    </Page>
  );
}

function NavLink({
  to,
  icon,
  label,
  count,
  urgent,
  under = to,
}: {
  to: string;
  icon: IconName;
  label: string;
  count?: number | undefined;
  urgent?: boolean;
  under?: string;
}) {
  const { path } = useLocation();
  const active = path === under || path.startsWith(`${under}/`);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active}>
        <Link to={to} aria-current={active ? "page" : undefined}>
          <Icon name={icon} size={16} />
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
      {!!count && (
        <SidebarMenuBadge
          className={cn(urgent && "rounded-full bg-warning text-background!")}
          title={urgent ? `${count} waiting for you` : `${count} working`}
        >
          {count}
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  );
}

function ChatMark({ t }: { t: Task }) {
  const base = "size-1.5 flex-none rounded-full";
  if (t.status === "running" || t.status === "queued")
    return <span className={cn(base, "bg-brand motion-safe:animate-pulse")} title="Working" />;
  if (t.pending) return <span className={cn(base, "bg-warning")} title="Needs your approval" />;
  if (t.status === "done" || t.status === "failed")
    return <span className={cn(base, "border border-muted-foreground opacity-60")} title="Closed" />;
  return <span className={base} />;
}

const PAUSED = "Queued tasks, schedules and the Planner wait until you resume. Running tasks go on.";

function PauseControl() {
  const p = useCall<{ paused: boolean }>("pause.get", {}, ["tasks"]);
  const [set, busy] = useAction(
    (paused: boolean) => call<{ paused: boolean }>("pause.set", { paused }),
    (r) => (r.paused ? "Paused" : "Resumed"),
  );
  const paused = !!p.data?.paused;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className="group/pause"
        disabled={busy || !p.data}
        title={paused ? "Resume hortus" : "Pause hortus"}
        onClick={async () => {
          if (paused || (await confirmAction({ title: "Pause hortus?", body: PAUSED, confirm: "Pause" }))) set(!paused);
        }}
      >
        <span className={cn("mx-1 size-2 rounded-full", paused ? "bg-warning" : "bg-success")} aria-hidden="true" />
        <span>{paused ? "Paused" : "Running"}</span>
        <span
          className={cn(
            "ml-auto text-xs text-muted-foreground group-hover/pause:opacity-100 pointer-coarse:opacity-100",
            !paused && "opacity-0",
          )}
        >
          {paused ? "Resume" : "Pause"}
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** Light or dark for this browser; "Match my device" stays in Settings › General. */
function ThemeSwitch() {
  const dark = isDark(useStore(theme));
  return (
    <SidebarMenuItem>
      <Label className="flex h-8 items-center gap-2 rounded-md px-2 font-normal hover:bg-sidebar-accent">
        <Icon name={dark ? "moon" : "sun"} size={16} />
        <span className="flex-1">Dark mode</span>
        <Switch
          size="sm"
          checked={dark}
          className="data-[state=checked]:bg-brand"
          onCheckedChange={(on) => theme.set(on ? "dark" : "light")}
        />
      </Label>
    </SidebarMenuItem>
  );
}

function AppSidebar() {
  const { path } = useLocation();
  const { setOpenMobile } = useSidebar();
  const tasks = useCall<Task[]>("task.list", {}, ["tasks", "approvals"]);
  const pending = useCall<number>("approval.count", {}, ["approvals"]);
  const [all, setAll] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a navigation closes the phone's drawer
  useEffect(() => setOpenMobile(false), [path, setOpenMobile]);
  const chats = (tasks.data ?? []).filter((t) => t.kind === "chat").sort((a, b) => b.updated.localeCompare(a.updated));
  const working = (tasks.data ?? []).filter((t) => t.status === "running").length;
  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center justify-between py-0.5 pl-2">
          <Brand />
          <SidebarTrigger aria-label="Hide sidebar" className="max-md:hidden" />
        </div>
        <Link to="/" className={cn(buttonVariants({ variant: "outline" }), "justify-start")}>
          <Icon name="plus" size={16} /> New chat
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="pb-0">
          <SidebarGroupContent>
            <SidebarMenu aria-label="Pages">
              <NavLink to="/approvals" icon="shield" label="Approvals" count={pending.data} urgent />
              <NavLink to="/tasks" icon="tasks" label="Tasks" count={working} />
              <NavLink to="/schedules" icon="clock" label="Schedules" />
              <NavLink to="/search" icon="search" label="Search" />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Chats</SidebarGroupLabel>
          <SidebarGroupContent>
            {chats.length ? (
              <SidebarMenu>
                {(all ? chats : chats.slice(0, 15)).map((c) => (
                  <SidebarMenuItem key={c.id}>
                    <SidebarMenuButton asChild isActive={path === `/chat/${c.id}`}>
                      <Link
                        to={`/chat/${c.id}`}
                        aria-current={path === `/chat/${c.id}` ? "page" : undefined}
                        title={c.title}
                      >
                        <ChatMark t={c} />
                        <span>{c.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
                {chats.length > 15 && (
                  <SidebarMenuItem>
                    <SidebarMenuButton className="text-muted-foreground" onClick={() => setAll(!all)}>
                      {all ? "Show fewer" : `Show all ${chats.length}`}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            ) : (
              <p className="px-2 text-[13px] text-muted-foreground">{tasks.data ? "Your chats show up here." : ""}</p>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t">
        <SidebarMenu>
          <NavLink to="/settings/general" under="/settings" icon="settings" label="Settings" />
          <ThemeSwitch />
          <PauseControl />
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

const Brand = () => (
  <Link to="/" className="inline-flex items-center gap-2 text-[17px] font-semibold tracking-tight">
    <Logo size={20} />
    <span>hortus</span>
  </Link>
);

/** On a phone, and on a computer once the sidebar is hidden: the way back to it. */
function TopBar() {
  const { open, isMobile } = useSidebar();
  if (open && !isMobile) return null;
  return (
    <header className="flex min-h-13 items-center gap-1.5 border-b px-2.5 py-1.5">
      <SidebarTrigger aria-label="Open the sidebar" />
      <Brand />
      <span className="grow" />
      <Link
        to="/"
        className={buttonVariants({ variant: "ghost", size: "icon" })}
        aria-label="New chat"
        title="New chat"
      >
        <Icon name="plus" />
      </Link>
    </header>
  );
}

function PausedBanner() {
  const p = useCall<{ paused: boolean }>("pause.get", {}, ["tasks"]);
  const [resume, busy] = useAction(() => call("pause.set", { paused: false }), "Resumed");
  if (!p.data?.paused) return null;
  return (
    <div
      className="flex items-center gap-2.5 border-b border-warning/30 bg-warning/10 px-5 py-2 text-[13px]"
      role="status"
    >
      <Icon name="pause" size={16} className="text-warning" />
      <span>
        <b>hortus is paused.</b> {PAUSED}
      </span>
      <Button size="sm" className="ml-auto" loading={busy} onClick={() => resume()}>
        Resume
      </Button>
    </div>
  );
}

function App() {
  const { path, query } = useLocation();
  if (path === "/login" || path === "/enroll")
    return (
      <>
        {path === "/login" ? <SignIn /> : <Enroll code={query.get("code")} />}
        <Toasts />
      </>
    );
  return (
    <TooltipProvider>
      {/* the sidebar's own cookie remembers whether it was open */}
      <SidebarProvider defaultOpen={!document.cookie.includes("sidebar_state=false")} className="h-svh overflow-hidden">
        <a
          href="#main"
          className="fixed top-2 left-2 z-100 -translate-y-[200%] rounded-lg bg-foreground px-3.5 py-2 text-background focus:translate-y-0"
        >
          Skip to content
        </a>
        <AppSidebar />
        <SidebarInset id="main" tabIndex={-1} className="min-w-0 overflow-hidden outline-none">
          <TopBar />
          <PausedBanner />
          <PageGuard key={path}>
            <Route path={path} />
          </PageGuard>
        </SidebarInset>
        <Toasts />
        <ConfirmHost />
      </SidebarProvider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
