# Welcome! See README.md (open as a preview tab beside this file) for an
# overview of the micro:bit Web IDE and its storage options.

from microbit import display, Image, sleep


def main():
    while True:
        display.scroll("Hello, micro:bit!")
        display.show(Image.HEART)
        sleep(1000)
        display.clear()
        sleep(500)


main()
