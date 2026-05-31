/**
 * Authors and copyright: Barak Michener (@barakmich) and Stefan Haack (@shaack)
 * Repository: https://github.com/shaack/cm-chessboard
 * License: MIT, see file 'LICENSE'
 */

import {Extension, EXTENSION_POINT} from "../../model/Extension.js"
import {Svg} from "../../lib/Svg.js"
import {Utils} from "../../lib/Utils.js"

const ARROW_COLORS = {
    "arrow-success": {stroke: "green", fill: "green"},
    "arrow-secondary": {stroke: "#666", fill: "#666"},
    "arrow-warning": {stroke: "orange", fill: "orange"},
    "arrow-info": {stroke: "blue", fill: "blue"},
    "arrow-danger": {stroke: "red", fill: "red"}
}

export const ARROW_TYPE = {
    default: {class: "arrow-success"},
    success: {class: "arrow-success"},
    secondary: {class: "arrow-secondary"},
    warning: {class: "arrow-warning"},
    info: {class: "arrow-info"},
    danger: {class: "arrow-danger"}
}

export class Arrows extends Extension {

    /** @constructor */
    constructor(chessboard, props = {}) {
        super(chessboard)
        this.registerExtensionPoint(EXTENSION_POINT.afterRedrawBoard, () => {
            this.onRedrawBoard()
        })
        this.registerExtensionPoint(EXTENSION_POINT.destroy, () => {
            this.onDestroy()
        })
        this.props = {
            headSize: 0.65,
            lineWidth: 0.18,
            offsetFrom: 0,
            offsetTo: 0.45
        }
        Object.assign(this.props, props)
        chessboard.addArrow = this.addArrow.bind(this)
        chessboard.getArrows = this.getArrows.bind(this)
        chessboard.removeArrows = this.removeArrows.bind(this)
        this.arrowGroup = Svg.addElement(chessboard.view.markersTopLayer, "g", {class: "arrows"})
        this.arrows = []
    }

    onDestroy() {
        this.arrows.length = 0
        if (this.arrowGroup && this.arrowGroup.parentNode) {
            this.arrowGroup.parentNode.removeChild(this.arrowGroup)
        }
        delete this.chessboard.addArrow
        delete this.chessboard.getArrows
        delete this.chessboard.removeArrows
    }

    onRedrawBoard() {
        while (this.arrowGroup.firstChild) {
            this.arrowGroup.removeChild(this.arrowGroup.firstChild)
        }
        this.arrows.forEach((arrow) => {
            this.drawArrow(arrow)
        })
    }

    drawArrow(arrow) {
        const view = this.chessboard.view
        const group = Svg.addElement(this.arrowGroup, "g")
        group.setAttribute("data-arrow", arrow.from + arrow.to)
        group.setAttribute("class", "arrow " + arrow.type.class)

        const colors = ARROW_COLORS[arrow.type.class] || ARROW_COLORS["arrow-warning"]

        const ptFrom = view.squareToPoint(arrow.from)
        const ptTo = view.squareToPoint(arrow.to)

        const cx1 = ptFrom.x + view.squareWidth / 2
        const cy1 = ptFrom.y + view.squareHeight / 2
        const cx2 = ptTo.x + view.squareWidth / 2
        const cy2 = ptTo.y + view.squareHeight / 2

        const dx = cx2 - cx1
        const dy = cy2 - cy1
        const len = Math.hypot(dx, dy) || 1
        const ux = dx / len
        const uy = dy / len

        const halfMin = Math.min(view.squareWidth, view.squareHeight) / 2
        const lineWidth = halfMin * this.props.lineWidth
        const headLen = halfMin * this.props.headSize
        const headWidth = halfMin * this.props.lineWidth * 2.2

        const offsetFrom = halfMin * this.props.offsetFrom
        const offsetTo = halfMin * this.props.offsetTo

        const sx = cx1 + ux * offsetFrom
        const sy = cy1 + uy * offsetFrom
        const ex = cx2 - ux * offsetTo
        const ey = cy2 - uy * offsetTo

        // Perpendicular unit vector
        const px = -uy
        const py = ux

        // Line from start to base of arrowhead
        const lineEndX = ex - ux * headLen
        const lineEndY = ey - uy * headLen

        const lineEl = Svg.addElement(group, "line")
        lineEl.setAttribute("x1", sx.toString())
        lineEl.setAttribute("y1", sy.toString())
        lineEl.setAttribute("x2", lineEndX.toString())
        lineEl.setAttribute("y2", lineEndY.toString())
        lineEl.setAttribute("stroke", colors.stroke)
        lineEl.setAttribute("stroke-width", lineWidth.toString())
        lineEl.setAttribute("stroke-linecap", "round")
        lineEl.setAttribute("opacity", "0.7")

        // Arrowhead as triangle
        const tipX = ex
        const tipY = ey
        const base1X = lineEndX + px * headWidth
        const base1Y = lineEndY + py * headWidth
        const base2X = lineEndX - px * headWidth
        const base2Y = lineEndY - py * headWidth

        const headEl = Svg.addElement(group, "polygon")
        headEl.setAttribute("points",
            tipX + "," + tipY + " " +
            base1X + "," + base1Y + " " +
            base2X + "," + base2Y
        )
        headEl.setAttribute("fill", colors.fill)
        headEl.setAttribute("opacity", "0.7")
    }

    addArrow(type, from, to) {
        this.arrows.push(new Arrow(from, to, type))
        this.onRedrawBoard()
    }

    getArrows(type = undefined, from = undefined, to = undefined) {
        let arrows = []
        this.arrows.forEach((arrow) => {
            if (arrow.matches(from, to, type)) {
                arrows.push(arrow)
            }
        })
        return arrows
    }

    removeArrows(type = undefined, from = undefined, to = undefined) {
        this.arrows = this.arrows.filter((arrow) => !arrow.matches(from, to, type))
        this.onRedrawBoard()
    }
}

class Arrow {
    constructor(from, to, type) {
        this.from = from
        this.to = to
        this.type = type
    }

    matches(from = undefined, to = undefined, type = undefined) {
        if (from && from !== this.from) {
            return false
        }
        if (to && to !== this.to) {
            return false
        }
        return !(type && type !== this.type)
    }
}