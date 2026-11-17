#include "assert_guard.h"
#include <setjmp.h>
#include <stddef.h>
/* This pointer must be placed in manager-reserved RAM when linked for XIP. */
static jmp_buf *volatile active_guard;
int bond_guarded_call(int (*operation)(void *), void *context)
{
    if (!operation || active_guard) return -1;
    jmp_buf guard;
    active_guard = &guard;
    int result;
    if (setjmp(guard) == 0) result = operation(context);
    else result = -1;
    active_guard = NULL;
    return result;
}
void bond_assert_failed(void)
{
    if (active_guard) longjmp(*active_guard, 1);
    /* An assertion outside a guarded call cannot be safely resumed. */
    for (;;) {}
}
