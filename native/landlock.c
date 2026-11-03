/*
 * hortus-landlock: hortus-landlock -- <cmd> [args...] with a profile on fd 3 (docs/design/04-host-sandbox.md).
 *   cgroup <dir>                 write our pid to <dir>/cgroup.procs (before the domain hides /sys/fs/cgroup)
 *   ro <path> | rw <path>        grant read / read+write beneath <path> (missing path: skipped)
 *   rn <path>                    read+write without RESOLVE_UNIX: shared trees (/tmp) hold other daemons' sockets
 *   scope signal | scope abstract
 *   end                          required: a truncated profile never runs open
 * Only `rw` grants RESOLVE_UNIX (ABI 9: connect to pathname sockets), so `ro` trees expose no daemon sockets.
 * hortus-landlock --abi prints the Landlock ABI version.
 * Exit: 64 bad profile/usage, 65 cgroup, 66 no Landlock, 67 exec failed (or a Landlock call failed).
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
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

static char profile[MAX_PROFILE + 1];
static char *rules[MAX_RULES]; /* "ro <path>" / "rw <path>", pointing into profile */
static int nrules;

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--abi") == 0) {
    printf("%d\n", abi());
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

  /* 3. Ruleset with every right this ABI knows. */
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

  /* 4. One rule per existing path, rights masked to what applies to its type. */
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

  /* 5. Restrict and exec. */
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) die(67, "PR_SET_NO_NEW_PRIVS failed", NULL, errno);
  if (syscall(__NR_landlock_restrict_self, rs, 0) < 0) die(67, "landlock_restrict_self failed", NULL, errno);
  close(rs);
  execvp(argv[2], argv + 2);
  die(67, "exec failed", argv[2], errno);
  return 67;
}
