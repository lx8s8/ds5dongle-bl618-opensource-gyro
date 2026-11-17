#pragma once
/* Prototype: used only in a single-threaded boot manager. */
int bond_guarded_call(int (*operation)(void *), void *context);
void bond_assert_failed(void) __attribute__((noreturn));
