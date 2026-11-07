#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>

__attribute__((noinline)) unsigned classify_bucket(unsigned value) {
    return ((value ^ 0x5au) & 0xffu) == 0x2au ? 7u : 3u;
}

int main(int argc, char **argv) {
    if (argc != 2 || argv[1][0] == '-' || argv[1][0] == '\0') return 2;
    char *end;
    errno = 0;
    unsigned long value = strtoul(argv[1], &end, 10);
    if (errno || *end || value > UINT_MAX) return 2;
    printf("bucket=%u\n", classify_bucket((unsigned)value));
    return 0;
}
