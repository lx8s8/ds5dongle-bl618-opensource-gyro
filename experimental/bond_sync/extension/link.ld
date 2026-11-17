ENTRY(bond_extension_run)
SECTIONS {
 . = 0xA0340000;
 .text : { KEEP(*(.entry)) *(.text*) *(.rodata*) }
 .data : { *(.data*) *(.sdata*) }
 .bss (NOLOAD) : { *(.bss*) *(.sbss*) *(COMMON) }
 /DISCARD/ : { *(.comment*) *(.riscv.attributes*) *(.eh_frame*) }
}
