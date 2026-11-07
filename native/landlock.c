/*
 * hortus-landlock: hortus-landlock -- <cmd> [args...] with a profile on fd 3.
 *   cgroup <dir>                 write our pid to <dir>/cgroup.procs (before the domain hides /sys/fs/cgroup)
 *   ro <path> | rw <path>        grant read / read+write beneath <path> (missing path: skipped)
 *   rn <path>                    read+write without RESOLVE_UNIX: shared trees (/tmp) hold other daemons' sockets
 *   scope signal | scope abstract
 *   pin <path>                   bind <path> onto itself: a mount point cannot be renamed, so neither can what holds a
 *                                read-only tree (a renamed parent would let a session swap the tree)
 *   rdonly <path>                bind <path> onto itself read-only
 *   mask <path>                  hide <path>: an empty tmpfs on a directory, a nodev /dev/null on anything else
 *   expose ro|rw <path>          put <path> back, as it was before any mask, inside a mask laid over it
 *   end                          required: a truncated profile never runs open
 * Mount directives run in profile order, in a new user and mount namespace (own uid and gid mapped 1:1), before the
 * Landlock rules are opened; they are mount points of that namespace only, and once exec drops the namespace's
 * capabilities nothing in the session can unmount them (a nested namespace gets them locked). Missing paths: skipped.
 * Only `rw` grants RESOLVE_UNIX (ABI 9: connect to pathname sockets), so `ro` trees expose no daemon sockets.
 * hortus-landlock --abi prints the Landlock ABI version; --userns exits 0 when the mount directives can run.
 * Exit: 64 bad profile/usage, 65 cgroup, 66 no Landlock, 67 exec failed (or a Landlock call failed), 68 mount setup.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sched.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif
#ifndef LANDLOCK_CREATE_RULESET_VERSION
#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#endif
#ifndef LANDLOCK_ACCESS_FS_EXECUTE
#define LANDLOCK_ACCESS_FS_EXECUTE (1ULL << 0)
#define LANDLOCK_ACCESS_FS_WRITE_FILE (1ULL << 1)
#define LANDLOCK_ACCESS_FS_READ_FILE (1ULL << 2)
#define LANDLOCK_ACCESS_FS_READ_DIR (1ULL << 3)
#define LANDLOCK_ACCESS_FS_REMOVE_DIR (1ULL << 4)
#define LANDLOCK_ACCESS_FS_REMOVE_FILE (1ULL << 5)
#define LANDLOCK_ACCESS_FS_MAKE_CHAR (1ULL << 6)
#define LANDLOCK_ACCESS_FS_MAKE_DIR (1ULL << 7)
#define LANDLOCK_ACCESS_FS_MAKE_REG (1ULL << 8)
#define LANDLOCK_ACCESS_FS_MAKE_SOCK (1ULL << 9)
#define LANDLOCK_ACCESS_FS_MAKE_FIFO (1ULL << 10)
#define LANDLOCK_ACCESS_FS_MAKE_BLOCK (1ULL << 11)
#define LANDLOCK_ACCESS_FS_MAKE_SYM (1ULL << 12)
#endif
#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)
#endif
#ifndef LANDLOCK_ACCESS_FS_RESOLVE_UNIX
#define LANDLOCK_ACCESS_FS_RESOLVE_UNIX (1ULL << 16)
#endif
#ifndef LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET
#define LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0)
#endif
#ifndef LANDLOCK_SCOPE_SIGNAL
#define LANDLOCK_SCOPE_SIGNAL (1ULL << 1)
#endif
#define RULE_PATH_BENEATH 1

#ifndef __NR_open_tree
#define __NR_open_tree 428
#endif
#ifndef __NR_move_mount
#define __NR_move_mount 429
#endif
#ifndef __NR_mount_setattr
#define __NR_mount_setattr 442
#endif
#define TREE_CLONE 1         /* OPEN_TREE_CLONE */
#define MOVE_EMPTY_PATH 0x4  /* MOVE_MOUNT_F_EMPTY_PATH */
#define RECURSIVE 0x8000     /* AT_RECURSIVE */
#define ATTR_RDONLY 0x1
#define ATTR_HIDDEN 0xf      /* RDONLY | NOSUID | NODEV | NOEXEC */
struct mount_attr_v0 {
  uint64_t attr_set, attr_clr, propagation, userns_fd;
};

/* Own copies of the uapi structs, so older headers build; trailing zero fields are accepted by older kernels. */
struct ruleset_attr {
  uint64_t handled_access_fs, handled_access_net, scoped;
};
struct path_beneath {
  uint64_t allowed_access;
  int32_t parent_fd;
} __attribute__((packed));

#define READ_SET (LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_EXECUTE)
#define WRITE_SET                                                                                                     \
  (LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |                    \
   LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |                          \
   LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK |                       \
   LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE | LANDLOCK_ACCESS_FS_IOCTL_DEV | \
   LANDLOCK_ACCESS_FS_RESOLVE_UNIX)
#define FILE_SET                                                                                                      \
  (LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_READ_FILE |                         \
   LANDLOCK_ACCESS_FS_TRUNCATE | LANDLOCK_ACCESS_FS_IOCTL_DEV | LANDLOCK_ACCESS_FS_RESOLVE_UNIX)

#define MAX_LINE 4096
#define MAX_PROFILE (1 << 20)
#define MAX_RULES 65536

/* One line on stderr: "<what>[: <arg>][ (<errno text>)]". */
static void die(int code, const char *what, const char *arg, int err) {
  fprintf(stderr, "hortus-landlock: %s%s%s%s%s%s\n", what, arg ? ": " : "", arg ? arg : "", err ? " (" : "",
          err ? strerror(err) : "", err ? ")" : "");
  exit(code);
}

static int abi(void) {
  long v = syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (v < 0) die(66, errno == EOPNOTSUPP ? "Landlock is disabled at boot" : "no Landlock in this kernel", NULL, errno);
  return (int)v;
}

/* A detached recursive clone of the tree at `p` (recursive: a clone may not uncover a locked mount). */
static int clone_tree(const char *p) {
  return (int)syscall(__NR_open_tree, AT_FDCWD, p, TREE_CLONE | RECURSIVE | O_CLOEXEC);
}

static void set_attr(int fd, const char *p, uint64_t attr) {
  struct mount_attr_v0 a = {.attr_set = attr};
  /* fd < 0: the mount at `p` alone (a mask's tmpfs, not what is exposed inside it) */
  if (syscall(__NR_mount_setattr, fd < 0 ? AT_FDCWD : fd, fd < 0 ? p : "", fd < 0 ? 0 : AT_EMPTY_PATH | RECURSIVE, &a,
              sizeof a) < 0)
    die(68, "cannot make a mount read-only", p, errno);
}

static void attach(int fd, const char *p) {
  if (syscall(__NR_move_mount, fd, "", AT_FDCWD, p, MOVE_EMPTY_PATH) < 0) die(68, "cannot mount", p, errno);
  close(fd);
}

static void write_file(const char *path, const char *text) {
  int fd = open(path, O_WRONLY | O_CLOEXEC);
  ssize_t n = (ssize_t)strlen(text);
  if (fd < 0 || write(fd, text, (size_t)n) != n) die(68, "cannot set up the user namespace", path, errno);
  close(fd);
}

/* A user and mount namespace with our uid and gid, mounts no longer shared back to the owner's namespace. */
static void enter_namespace(void) {
  uid_t uid = getuid();
  gid_t gid = getgid();
  char map[64];
  if (unshare(CLONE_NEWUSER | CLONE_NEWNS) < 0) die(68, "cannot create a user namespace", NULL, errno);
  write_file("/proc/self/setgroups", "deny");
  snprintf(map, sizeof map, "%u %u 1\n", uid, uid);
  write_file("/proc/self/uid_map", map);
  snprintf(map, sizeof map, "%u %u 1\n", gid, gid);
  write_file("/proc/self/gid_map", map);
  /* EPERM here, after unshare succeeded: Ubuntu's apparmor_restrict_unprivileged_userns took the capabilities */
  if (mount(NULL, "/", NULL, MS_REC | MS_SLAVE, NULL) < 0) die(68, "cannot mount in the user namespace", NULL, errno);
}

/* mkdir -p of an expose point inside a mask (missing components only); a file's last component is created as one. */
static void make_point(char *p, int dir) {
  for (char *s = strchr(p + 1, '/');; s = strchr(s + 1, '/')) {
    if (s) *s = 0;
    struct stat st;
    if (stat(p, &st) < 0) {
      int r = s || dir ? mkdir(p, 0111) : close(open(p, O_CREAT | O_WRONLY | O_CLOEXEC, 0600));
      if (r < 0) die(68, "cannot create a mount point", p, errno);
    }
    if (!s) return;
    *s = '/';
  }
}

static char profile[MAX_PROFILE + 1];
static char *rules[MAX_RULES]; /* "ro <path>" / "rw <path>", pointing into profile */
static int nrules;
static char *mounts[MAX_RULES]; /* pin / rdonly / mask / expose lines, in order */
static int nmounts;
static int exposed[MAX_RULES]; /* per mounts[i]: an expose's clone, taken before any mask */

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--abi") == 0) {
    printf("%d\n", abi());
    return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--userns") == 0) {
    enter_namespace();
    int fd = clone_tree("/");
    if (fd < 0) die(68, "no open_tree (Linux 5.12 or later)", NULL, errno);
    set_attr(fd, "/", ATTR_RDONLY);
    return 0;
  }
  if (argc < 3 || strcmp(argv[1], "--") != 0) die(64, "usage: hortus-landlock -- <cmd> [args...] (profile on fd 3)", NULL, 0);

  /* 1. Read the whole profile. */
  size_t len = 0;
  for (;;) {
    if (len == MAX_PROFILE) die(64, "profile over 1 MB", NULL, 0);
    ssize_t r = read(3, profile + len, MAX_PROFILE - len);
    if (r < 0 && errno == EINTR) continue;
    if (r < 0) die(64, "cannot read the profile on fd 3", NULL, errno);
    if (r == 0) break;
    len += (size_t)r;
  }
  close(3);
  profile[len] = 0;

  const char *cgroup = NULL;
  uint64_t scoped = 0;
  int ended = 0;
  for (char *line = profile, *next; *line && !ended; line = next) {
    char *nl = strchr(line, '\n');
    if (!nl) die(64, "profile truncated (no newline after the last line)", NULL, 0);
    *nl = 0;
    next = nl + 1;
    if (nl - line > MAX_LINE) die(64, "profile line over 4096 bytes", NULL, 0);
    if (strcmp(line, "end") == 0) ended = 1;
    else if (strncmp(line, "cgroup /", 8) == 0) cgroup = line + 7;
    else if (strncmp(line, "ro /", 4) == 0 || strncmp(line, "rw /", 4) == 0 || strncmp(line, "rn /", 4) == 0) {
      if (nrules == MAX_RULES) die(64, "too many rules", NULL, 0);
      rules[nrules++] = line;
    } else if (strncmp(line, "pin /", 5) == 0 || strncmp(line, "rdonly /", 8) == 0 || strncmp(line, "mask /", 6) == 0 ||
               strncmp(line, "expose ro /", 11) == 0 || strncmp(line, "expose rw /", 11) == 0) {
      if (nmounts == MAX_RULES) die(64, "too many mounts", NULL, 0);
      mounts[nmounts++] = line;
    } else if (strcmp(line, "scope signal") == 0) scoped |= LANDLOCK_SCOPE_SIGNAL;
    else if (strcmp(line, "scope abstract") == 0) scoped |= LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET;
    else die(64, "unknown directive", line, 0);
  }
  if (!ended) die(64, "profile truncated (no end line)", NULL, 0);

  /* 2. Join the cgroup while /sys/fs/cgroup is still reachable. */
  if (cgroup) {
    char path[MAX_LINE + 32], pid[32];
    snprintf(path, sizeof path, "%s/cgroup.procs", cgroup);
    int n = snprintf(pid, sizeof pid, "%d\n", getpid());
    int fd = open(path, O_WRONLY | O_CLOEXEC);
    if (fd < 0 || write(fd, pid, (size_t)n) != n) die(65, "cannot join the cgroup", path, errno);
    close(fd);
  }

  /* 3. Mounts, in order: the Landlock rules below open their paths in this namespace. */
  if (nmounts) {
    enter_namespace();
    for (int i = 0; i < nmounts; i++) {
      exposed[i] = -1;
      if (strncmp(mounts[i], "expose ", 7) != 0) continue;
      exposed[i] = clone_tree(mounts[i] + 10);
      if (exposed[i] < 0 && errno != ENOENT) die(68, "cannot clone", mounts[i] + 10, errno);
      if (exposed[i] >= 0 && mounts[i][8] == 'o') set_attr(exposed[i], mounts[i] + 10, ATTR_RDONLY);
    }
    static const char *masks[MAX_RULES];
    int nmasks = 0;
    for (int i = 0; i < nmounts; i++) {
      char *p = strchr(mounts[i], ' ') + 1;
      if (mounts[i][0] == 'e') {
        if (exposed[i] < 0) continue;
        p += 3;
        struct stat st;
        if (fstat(exposed[i], &st) < 0) die(68, "cannot stat", p, errno);
        /* inside a mask: its root lets the session through (0111: nothing to list) to what is put back */
        for (int m = 0; m < nmasks; m++) {
          size_t n = strlen(masks[m]);
          if (strncmp(p, masks[m], n) == 0 && p[n] == '/' && chmod(masks[m], 0111) < 0)
            die(68, "cannot chmod", masks[m], errno);
        }
        make_point(p, S_ISDIR(st.st_mode));
        attach(exposed[i], p);
        continue;
      }
      struct stat st;
      if (stat(p, &st) < 0) {
        if (errno == ENOENT) continue;
        die(68, "cannot stat", p, errno);
      }
      if (mounts[i][0] == 'p' || mounts[i][0] == 'r') {
        int fd = clone_tree(p);
        if (fd < 0) die(68, "cannot clone", p, errno);
        if (mounts[i][0] == 'r') set_attr(fd, p, ATTR_RDONLY);
        attach(fd, p);
      } else if (S_ISDIR(st.st_mode)) {
        if (mount("tmpfs", p, "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, "mode=0,size=1m,nr_inodes=1k") < 0)
          die(68, "cannot mask", p, errno);
        masks[nmasks++] = p;
      } else {
        int fd = clone_tree("/dev/null");
        if (fd < 0) die(68, "cannot clone", "/dev/null", errno);
        set_attr(fd, p, ATTR_HIDDEN);
        attach(fd, p);
      }
    }
    /* last: the expose points are made, nothing more is written to a mask */
    for (int m = 0; m < nmasks; m++) set_attr(-1, masks[m], ATTR_HIDDEN);
  }

  /* 4. Ruleset with every right this ABI knows. */
  int v = abi();
  uint64_t handled = READ_SET | WRITE_SET;
  if (v < 2) handled &= ~LANDLOCK_ACCESS_FS_REFER;
  if (v < 3) handled &= ~LANDLOCK_ACCESS_FS_TRUNCATE;
  if (v < 5) handled &= ~LANDLOCK_ACCESS_FS_IOCTL_DEV;
  if (v < 9) handled &= ~LANDLOCK_ACCESS_FS_RESOLVE_UNIX;
  struct ruleset_attr attr = {.handled_access_fs = handled};
  if (scoped && v >= 6) attr.scoped = scoped;
  else if (scoped) fprintf(stderr, "hortus-landlock: ABI %d has no scoping; signal/abstract scope not applied\n", v);
  int rs = (int)syscall(__NR_landlock_create_ruleset, &attr, v >= 6 ? sizeof attr : 2 * sizeof(uint64_t), 0);
  if (rs < 0) die(67, "landlock_create_ruleset failed", NULL, errno);

  /* 5. One rule per existing path, rights masked to what applies to its type. */
  for (int i = 0; i < nrules; i++) {
    const char *p = rules[i] + 3;
    int fd = open(p, O_PATH | O_CLOEXEC);
    if (fd < 0 && errno == ENOENT) continue;
    if (fd < 0) die(64, "cannot open a profile path", p, errno);
    struct stat st;
    if (fstat(fd, &st) < 0) die(64, "cannot stat a profile path", p, errno);
    uint64_t rights = rules[i][1] == 'w' ? READ_SET | WRITE_SET
                      : rules[i][1] == 'n' ? (READ_SET | WRITE_SET) & ~LANDLOCK_ACCESS_FS_RESOLVE_UNIX
                                           : READ_SET;
    if (!S_ISDIR(st.st_mode)) rights &= FILE_SET;
    struct path_beneath pb = {.allowed_access = rights & handled, .parent_fd = fd};
    if (syscall(__NR_landlock_add_rule, rs, RULE_PATH_BENEATH, &pb, 0) < 0) die(67, "landlock_add_rule failed", p, errno);
    close(fd);
  }

  /* 6. Restrict and exec. */
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) die(67, "PR_SET_NO_NEW_PRIVS failed", NULL, errno);
  if (syscall(__NR_landlock_restrict_self, rs, 0) < 0) die(67, "landlock_restrict_self failed", NULL, errno);
  close(rs);
  execvp(argv[2], argv + 2);
  die(67, "exec failed", argv[2], errno);
  return 67;
}
