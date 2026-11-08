/** Settings › Projects: the repositories and folders Workers may change, each with its own origin. */
import { useEffect, useState } from "react";
import { type Config, call, type Snapshot, useCall } from "../api.ts";
import { type Draft, PROJECT_NAME, PROJECT_NAME_HINT } from "../schema.ts";
import {
  Button,
  Card,
  Choice,
  confirmAction,
  Dialog,
  Empty,
  Icon,
  IconButton,
  ListInput,
  Pill,
  RelTime,
  SectionHead,
  Spinner,
  TextField,
  useAction,
} from "../ui.tsx";

type Project = Config["projects"][string];

function Snapshots({ name }: { name: string }) {
  const list = useCall<Snapshot[]>("project.snapshots", { name }, ["settings"]);
  const [restore] = useAction(
    (sha: string) => call("project.restore", { name, sha }),
    `Restored ${name}; what changed since is in a newer snapshot`,
  );
  if (!list.data?.length) return null;
  return (
    <details className="[&>summary]:cursor-pointer [&>summary]:text-[13px] [&>summary]:font-medium [&>summary]:text-foreground/80 [&[open]>summary]:mb-2 [&>pre]:max-h-72 [&>pre]:overflow-auto [&>pre]:rounded-md [&>pre]:border [&>pre]:bg-muted/50 [&>pre]:p-2.5 [&>pre]:text-xs [&>pre]:wrap-anywhere [&>pre]:whitespace-pre-wrap">
      <summary>Snapshots ({list.data.length})</summary>
      <p className="text-muted-foreground text-[13px]">
        Taken before each task changed the folder. Restoring rewrites the folder to that moment.
      </p>
      <ul className="divide-y">
        {list.data.map((s) => (
          <li
            key={s.sha}
            className="flex items-center gap-3 px-1 py-3 first:pt-1 last:pb-1 [&>svg]:text-muted-foreground"
          >
            <Icon name="clock" />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 font-medium [&_code]:rounded-md [&_code]:border [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-px [&_code]:text-xs">
                <RelTime iso={s.ts} /> <code className="text-muted-foreground">{s.sha.slice(0, 7)}</code>
              </p>
              <p className="text-muted-foreground text-[13px] truncate">{s.message}</p>
            </div>
            <Button
              size="sm"
              onClick={async () => {
                if (
                  await confirmAction({
                    title: "Restore this snapshot?",
                    body: `${name} goes back to how it was then. What changed since is snapshotted first, so this can be undone.`,
                    confirm: "Restore",
                  })
                )
                  restore(s.sha);
              }}
            >
              Restore
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ProjectDialog({
  open,
  onClose,
  editing,
  projects,
}: {
  open: boolean;
  onClose: () => void;
  editing: string | null;
  projects: Config["projects"];
}) {
  const [name, setName] = useState("");
  const [p, setP] = useState<Project>({ path: "", main: "main", runtime: "host" });
  useEffect(() => {
    if (!open) return;
    setName(editing ?? "");
    setP(
      editing && projects[editing] ? structuredClone(projects[editing]) : { path: "", main: "main", runtime: "host" },
    );
  }, [open, editing, projects]);
  const nameError =
    name && !PROJECT_NAME.test(name)
      ? PROJECT_NAME_HINT
      : !editing && name in projects
        ? "there is a project by this name"
        : undefined;
  const pathError = p.path && !p.path.startsWith("/") ? "an absolute path, starting with /" : undefined;
  const [save, busy] = useAction(async () => {
    await call("project.set", {
      name,
      ...p,
      ...(p.exclude?.length ? {} : { exclude: undefined }),
    });
    onClose();
    return { message: editing ? `Saved ${name}` : `Added ${name}; its origin is in sync` };
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? `Edit ${editing}` : "Add a project"}
      description="A repository or folder on this machine. Workers change a copy and push a branch; you approve the merge into your main."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name || !!nameError || !p.path || !!pathError}
            onClick={() => save()}
          >
            {editing ? "Save" : "Add project"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 *:data-[slot=button]:self-start">
        {!editing && (
          <TextField
            label="Name"
            value={name}
            onChange={setName}
            mono
            error={nameError}
            autoFocus
            placeholder="my-app"
          />
        )}
        <TextField
          label="Folder"
          hint="Where it is on this machine. A git repository works on branches; any other folder gets snapshots."
          value={p.path}
          onChange={(v) => setP({ ...p, path: v })}
          mono
          placeholder="/home/you/projects/my-app"
          error={pathError}
        />
        <TextField
          label="Main branch"
          def="main"
          value={p.main}
          onChange={(v) => setP({ ...p, main: v || "main" })}
          mono
        />
        <Choice
          label="Where its tasks run"
          cards
          value={p.runtime}
          onChange={(v) => setP({ ...p, runtime: v })}
          options={[
            { value: "host", label: "This machine", icon: "box", hint: "In the sandbox. Fast to start." },
            {
              value: "vm",
              label: "Its own VM",
              icon: "server",
              hint: "For builds that need root, containers or a clean system.",
            },
          ]}
        />
        <ListInput
          label="Leave out of snapshots"
          optional
          hint="For a folder that is not a git repository: files to keep out, as .gitignore patterns."
          values={p.exclude ?? []}
          onChange={(v) => setP({ ...p, exclude: v })}
          placeholder="*.pdf"
        />
      </div>
    </Dialog>
  );
}

export function Projects({ d }: { d: Draft }) {
  const status = useCall<Record<string, { git: boolean }>>("project.status", {}, ["settings"]);
  const [dialog, setDialog] = useState<{ editing: string | null } | null>(null);
  const [sync] = useAction(
    (name: string) => call<{ moved: boolean }>("project.sync", { name, force: true }),
    (r) => (r.moved ? "The origin's main now matches your checkout" : "Already in sync"),
  );
  const [remove] = useAction((name: string) => call("project.delete", { name }), "Removed");
  const list = Object.entries(d.saved.projects);
  return (
    <>
      <SectionHead
        title="Projects"
        description="The repositories and folders Workers may change. Each has its own origin inside hortus: a Worker pushes a branch, and you approve the merge into main."
        action={
          <Button variant="primary" icon="plus" onClick={() => setDialog({ editing: null })}>
            Add a project
          </Button>
        }
      />
      {list.length ? (
        <div className="flex flex-col gap-4 *:data-[slot=button]:self-start">
          {list.map(([name, p]) => {
            const st = status.data?.[name];
            return (
              <Card key={name} className="">
                <div className="flex flex-wrap items-center gap-x-3.5 gap-y-3">
                  <span className="grid size-10 flex-none place-items-center rounded-lg bg-brand/10 text-brand">
                    <Icon name="folder" />
                  </span>
                  <div className="min-w-44 flex-1 [&_h3]:text-base [&_h3]:font-semibold [&_p]:mt-0.5">
                    <h3>{name}</h3>
                    <p className="text-muted-foreground text-[13px] font-mono truncate">{p.path}</p>
                  </div>
                  {st ? <Pill>{st.git ? "Git repository" : "Folder with snapshots"}</Pill> : <Spinner size={14} />}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" icon="edit" onClick={() => setDialog({ editing: name })}>
                      Edit
                    </Button>
                    <IconButton
                      label="Sync now"
                      icon="refresh"
                      size="sm"
                      onClick={async () => {
                        if (
                          await confirmAction({
                            title: `Sync ${name} now?`,
                            body: "The origin's main is overwritten with your checkout's, even if you rewrote it (a rebase, a reset). Merges waiting on the old main go back to their tasks to rebase.",
                            confirm: "Sync now",
                          })
                        )
                          sync(name);
                      }}
                    />
                    <IconButton
                      label={`Remove ${name}`}
                      icon="trash"
                      size="sm"
                      onClick={async () => {
                        if (
                          await confirmAction({
                            title: `Remove ${name}?`,
                            body: "Workers can no longer change it, and merges waiting on it are dropped. Your folder is not touched; hortus's copy of its origin stays on disk, renamed .removed-<time>.",
                            confirm: "Remove",
                            danger: true,
                          })
                        )
                          remove(name);
                      }}
                    />
                  </div>
                </div>
                <dl className="mt-1 flex flex-wrap gap-x-7 gap-y-2 [&_dd]:text-[13px] [&_dt]:text-xs [&_dt]:text-muted-foreground">
                  <div>
                    <dt>Main branch</dt>
                    <dd>
                      <code>{p.main}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Tasks run</dt>
                    <dd>{p.runtime === "vm" ? "in their own VM" : "on this machine"}</dd>
                  </div>
                  {!!p.exclude?.length && (
                    <div>
                      <dt>Left out</dt>
                      <dd>
                        <code>{p.exclude.join(" ")}</code>
                      </dd>
                    </div>
                  )}
                </dl>
                {st && !st.git && <Snapshots name={name} />}
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <Empty
            icon="folder"
            title="No projects yet"
            action={
              <Button variant="primary" icon="plus" onClick={() => setDialog({ editing: null })}>
                Add a project
              </Button>
            }
          >
            Add a repository or folder, and chats can work in it. Without one, a chat works in a scratch folder.
          </Empty>
        </Card>
      )}
      <ProjectDialog
        open={!!dialog}
        onClose={() => setDialog(null)}
        editing={dialog?.editing ?? null}
        projects={d.saved.projects}
      />
    </>
  );
}
